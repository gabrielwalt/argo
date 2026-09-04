import fs from 'fs/promises'
import path from 'path'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'
import { truncateOutput } from './truncate.js'

// path.resolve() is purely lexical — it does not follow symlinks. A symlink
// created inside /workspace pointing elsewhere (trivially doable via the
// unrestricted `bash` tool: `ln -s /etc /workspace/x`) would pass the
// lexical check below, then fs.readFile/writeFile would follow it for real.
// This does not cross the actual security boundary (the container — see
// CLAUDE.md's Zero trust section; bash already has unrestricted access to
// everything reachable this way), but it means write_file/read_file's own
// stated guarantee ("outside workspace not allowed") wasn't actually true
// once a symlink was involved. realpathBoundary re-checks the *real* path
// after resolving whatever prefix of it already exists.
async function realpathBoundary(resolved: string, root: string): Promise<string> {
  const realRoot = await fs.realpath(root).catch(() => root)
  let dir = resolved
  const suffix: string[] = []
  // Walk up to the first existing ancestor — write_file's target may not
  // exist yet, but realpath requires an existing path.
  for (;;) {
    try {
      await fs.access(dir)
      break
    } catch {
      suffix.unshift(path.basename(dir))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const realDir = await fs.realpath(dir).catch(() => dir)
  const real = suffix.length ? path.join(realDir, ...suffix) : realDir
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`Path traversal outside ${path.basename(root)} not allowed (resolved outside the sandbox via symlink)`)
  }
  return real
}

async function safePath(filePath: string): Promise<string> {
  // /workspace is the only path whose confinement matters — it's the user's
  // git-tracked deliverable, not a security boundary (the container already
  // is one — see CLAUDE.md's Zero trust section; bash has unrestricted reach
  // regardless) but a workflow guarantee: a write must land inside the real
  // repo, not silently escape it via ../ or (trivially, via bash) a symlink.
  // Exact match or a real path-separator boundary, not a bare .startsWith —
  // otherwise "/workspace-evil/..." would incorrectly match this branch too.
  if (filePath === '/workspace' || filePath.startsWith('/workspace/')) {
    if (!config.workspacePath) throw new Error('No workspace mounted')
    const rel = filePath.replace(/^\/workspace\/?/, '')
    const resolved = path.resolve(config.workspacePath, rel)
    if (resolved !== config.workspacePath && !resolved.startsWith(config.workspacePath + path.sep)) {
      throw new Error('Path traversal outside workspace not allowed')
    }
    return realpathBoundary(resolved, config.workspacePath)
  }
  // Anywhere else in the container is ordinary, unmanaged filesystem — bash
  // already has unrestricted reach here, so rejecting it bought nothing but
  // confusion. No confinement, just normal path resolution.
  return path.resolve(filePath)
}

// Counts lines the way an editor or `wc -l` would, not the way a naive
// content.split('\n') would: "a\nb\n".split('\n') is ['a','b',''] — a
// trailing newline (the normal end-of-file case) would otherwise inflate
// the count by one and put the offset/limit marker below one line off from
// what the model sees when it opens the same file with `sed -n`. The number
// this produces is exactly what the self-describing marker below reports as
// "file has N lines", so it has to match what offset/limit actually index.
function splitLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

// offset/limit come in from JSON tool-call arguments — untrusted shape, not
// just untrusted value (a model can send a string, 0, a negative number, or
// NaN). Rather than throw on a malformed paging request (which would waste
// the same turn budget the traced failure ran out of — see file-ops.ts's
// module comment / the task's measured-defect section), clamp to the
// smallest sane value and proceed. Returns undefined only when nothing
// usable was supplied, which readFile treats as "no explicit value here."
function normalizePositiveInt(n: number | undefined): number | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined
  return Math.max(1, Math.floor(n))
}

// Paging is opt-in: pass neither offset nor limit and this is byte-for-byte
// the pre-existing function (same truncateOutput(content, 8000) call, same
// 500-char head + ~7440-char tail shape). That equivalence is deliberate and
// load-bearing, not incidental — see the task write-up: a caller that never
// asks for paging must see exactly what it saw before, so this ships without
// a flag and without touching bash's or agent.ts's own unrelated callers of
// truncateOutput (neither is touched by this file at all).
//
// With offset and/or limit supplied, this instead returns a specific
// 1-based line range (offset defaults to 1 if only limit is given; limit
// defaults to "rest of file" if only offset is given), still capped at 8000
// chars for the same reason the whole-file path is capped — an unbounded
// slice just relocates the context-flooding hazard instead of removing it.
// The result is prefixed with a marker naming the file's total line count
// and the exact range returned, e.g.
//   [file has 2790 lines; showing lines 1-120 of 2790; use offset/limit to read another range]
// This is the fix for the measured failure: a Planner frame that read
// lib/command.js (2790 lines) via the old head+tail-only truncation had no
// way to reach handleOptionValue in the invisible middle, no bash (not in
// ROLE_TOOLS.planner), and by turn 11 no legal read_file retry left either
// (loop guard blocks duplicate calls) — it burned its whole budget and
// scored 0/60. The marker's wording is deliberately short, literal, and
// names the exact parameters ("offset/limit") a small model needs to type
// to aim its next call, instead of just reporting how much was cut.
// SEARCH MODE (pattern). Measured tonight: two Planner frames on the harder
// task each burned their full 40-iteration budget and ended in error — one
// consuming 94% of its run's tokens — while attempting `bash` 9 and 7 times
// respectively to grep for `option.requires` call sites in a 2790-line
// file; every attempt was rejected on role (ROLE_TOOLS.planner has no
// `bash`, therefore no `grep`). Paging (offset/limit, below) fixed READING
// an already-known range; it did nothing for FINDING that range in the
// first place — the model could now reach any line, but had no way to pick
// which line to reach without scanning page after page. This is the fix
// for that, built on read_file's own boundary/symlink checks and byte-cap
// discipline (reused verbatim below) rather than a second tool or a bash
// grant to a planning role — a role this codebase has already logged 48
// rejected implement attempts from.
//
// pattern is matched as a LITERAL SUBSTRING, never a regular expression. A
// small local model asked to "search" reaches for whatever it already has
// in front of it: a bare identifier, a dotted call like "option.requires",
// a fragment of code with parens/brackets/dots. Every one of those is a
// valid literal substring; almost none is a valid *regex* without escaping
// first, and "option.requires" as a regex matches "option<any-char>
// requires" — a plausible-looking wrong hit, not an error, so the model
// would not even know to distrust it. That silent-wrong-answer failure
// mode is strictly worse than the one this task is fixing. Literal
// substring is exactly the contract `grep -F` gives, and str.includes()
// gives it for free with no escaping step and therefore no invalid-pattern
// case to ever report.
//
// Matches are returned as `<1-based line number>: <line text>`, with no
// surrounding context lines. That is deliberate: the point of pairing this
// with offset/limit is a two-call workflow — search, then page to the hit
// — so folding context into every match here would just re-introduce, in
// miniature, the exact bulk-output problem paging exists to avoid, while a
// dedicated offset/limit follow-up already shows context perfectly well.
//
// Matches are capped at MAX_PATTERN_MATCHES AND the assembled match text is
// still run through the same truncateOutput(_, 8000) every other read_file
// path uses. The count cap keeps a common pattern (e.g. "option" in a
// 2790-line file — hundreds of hits) from ever reaching truncateOutput
// with an enormous input; the char cap backstops the case the count cap
// doesn't cover, e.g. unusually long matched lines. Either way the marker
// states the true total match count rather than silently clamping — the
// same rule the offset-past-end-of-file branch below already follows.
//
// Interaction with offset/limit: when pattern is given, offset/limit stop
// meaning "which lines of the file to RETURN" and instead mean "which
// lines of the file to SEARCH" — the scan window, not the output window.
// Chosen over rejecting the combination because it is strictly more useful
// with no added ambiguity: a model that has already paged to roughly the
// right area can narrow a search to that area instead of rescanning the
// whole file, and reported line numbers are always absolute (real file
// line numbers), so they feed straight back into a plain offset/limit call
// next turn.
const MAX_PATTERN_MATCHES = 50

// A search always spans the WHOLE file. offset/limit are NOT consulted here, and that is a
// correction of this function's first version rather than an oversight.
//
// MEASURED 2026-09-04, live Planner frame on commander-option-requires: scoping the search by
// offset/limit was defensible on paper ("narrow a search to an already-paged area") but it
// collided with a habit the model had already learned from the paging change that shipped three
// hours earlier — it passes offset/limit on almost every read. Straight from the log:
//
//   [pattern "_checkForConflictingOptions" matched 0 times in lines 1-50 of 2790]
//   [pattern "_checkForConflictingOptions" matched 0 times in lines 1-100 of 2790]
//   [pattern "ConflictingOptions" matched 0 times in lines 1-20 of 2790]
//
// Six of seven searches in that frame returned zero matches for symbols that EXIST, purely
// because a window was carried over from the previous read. The zero-match hint then pointed at
// the wrong variable ("try a shorter or different substring"), so the model kept shortening the
// pattern inside a 20-to-50-line window instead of widening the window. A false negative with a
// plausible explanation is the same failure class that made this a literal substring rather than
// a regex: a wrong answer the model has no reason to distrust.
//
// Whole-file search removes that class outright. When offset/limit were supplied they are named
// as ignored rather than dropped in silence, because silently discarding an argument teaches the
// model nothing about the tool's actual shape.
function searchLines(content: string, pattern: string, windowIgnored: boolean): ToolResult {
  const lines = splitLines(content)
  const totalLines = lines.length
  const note = windowIgnored ? ' (offset/limit ignored: a search always covers the whole file)' : ''
  let totalMatches = 0
  const shown: string[] = []
  for (let i = 0; i < totalLines; i++) {
    if (lines[i].includes(pattern)) {
      totalMatches++
      if (shown.length < MAX_PATTERN_MATCHES) shown.push(`${i + 1}: ${lines[i]}`)
    }
  }
  if (totalMatches === 0) {
    // A clear statement, not an empty string and not an error — the read succeeded and the
    // pattern legitimately is not there. An empty string is indistinguishable from a bug; an
    // error makes the model retry the identical call, wasting the turn this exists to save.
    return { output: `[pattern ${JSON.stringify(pattern)} matched 0 times in ${totalLines} lines${note}; try a shorter or different substring]` }
  }
  const countNote = shown.length < totalMatches
    ? `${totalMatches} times (showing first ${shown.length})`
    : `${totalMatches} time${totalMatches === 1 ? '' : 's'}`
  const marker = `[pattern ${JSON.stringify(pattern)} matched ${countNote} in ${totalLines} lines${note}; use offset/limit to read near a line number]`
  return { output: `${marker}\n${truncateOutput(shown.join('\n'), 8000)}` }
}

export async function readFile(filePath: string, offset?: number, limit?: number, pattern?: string): Promise<ToolResult> {
  try {
    const abs = await safePath(filePath)
    const content = await fs.readFile(abs, 'utf-8')
    // pattern present (and non-empty) is the ONLY branch point added by
    // this change — everything below is untouched from before it existed.
    // An explicit empty string is treated the same as absent (not "match
    // every line"): a model that sent '' almost certainly meant "no
    // pattern", and treating it as "match everything" would dump the
    // entire file through the match-formatting path, recreating exactly
    // the flood this feature exists to prevent.
    if (pattern) {
      // Whole-file search; offset/limit are reported as ignored rather than applied.
      // See searchLines' header for the measured reason (six of seven live searches
      // returned false negatives when a carried-over window scoped them).
      return searchLines(content, pattern, offset !== undefined || limit !== undefined)
    }
    if (offset === undefined && limit === undefined) {
      return { output: truncateOutput(content, 8000) }
    }
    const lines = splitLines(content)
    const totalLines = lines.length
    const startLine = normalizePositiveInt(offset) ?? 1  // 1-based
    const startIdx = startLine - 1
    if (startIdx >= totalLines) {
      // A real, readable file with a request past its end is not an error
      // (the path resolved and the read succeeded) and must not be silently
      // clamped to the last page either — that would let the model believe
      // it saw the range it asked for. State the true length instead, so
      // the very next call can be aimed correctly.
      return { output: `[file has ${totalLines} lines; offset ${startLine} is past end of file; nothing to show]` }
    }
    const count = normalizePositiveInt(limit)
    const endIdx = count === undefined ? totalLines : Math.min(totalLines, startIdx + count)  // 0-based exclusive == 1-based last line shown
    const slice = lines.slice(startIdx, endIdx).join('\n')
    const body = truncateOutput(slice, 8000)
    const marker = `[file has ${totalLines} lines; showing lines ${startLine}-${endIdx} of ${totalLines}; use offset/limit to read another range]`
    return { output: `${marker}\n${body}` }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}

export async function writeFile(filePath: string, content: string): Promise<ToolResult> {
  try {
    const abs = await safePath(filePath)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf-8')
    return { output: `Written: ${filePath}` }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}

// A few lines of context around the edited region, line-numbered, so the caller
// can confirm the change landed where expected WITHOUT re-reading the file —
// the "did my edit apply? let me look again…" round trip is the loop this
// avoids. matchIndex is the byte offset of the (first) replacement in `updated`.
function editedRegion(updated: string, newString: string, matchIndex: number): string {
  const startLine = updated.slice(0, matchIndex).split('\n').length - 1  // 0-based
  const newLineCount = newString ? newString.split('\n').length : 1
  const lines = updated.split('\n')
  const from = Math.max(0, startLine - 2)
  const to = Math.min(lines.length, startLine + newLineCount + 2)
  return lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n')
}

// Exact-string replace that always reports what it did — the point is the
// feedback, not the mechanism. It confirms how many occurrences changed and
// echoes the updated region; it errors loudly (and changes nothing) when the
// text is missing or ambiguous, instead of silently no-op'ing the way `sed -i`
// does. That unambiguous signal is what lets the model stop guessing.
export async function editFile(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<ToolResult> {
  try {
    const abs = await safePath(filePath)
    let content: string
    try {
      content = await fs.readFile(abs, 'utf-8')
    } catch {
      return { output: '', error: `File not found: ${filePath} — read it first, or use write_file to create it.` }
    }
    if (oldString === '') {
      return { output: '', error: 'old_string is empty — give the exact existing text to replace (or use write_file to create/overwrite a file).' }
    }
    if (oldString === newString) {
      return { output: '', error: 'old_string and new_string are identical — nothing to change.' }
    }
    const matchIndex = content.indexOf(oldString)
    if (matchIndex === -1) {
      return { output: '', error: `old_string not found in ${filePath}; the file was NOT modified. It must match exactly, including whitespace and indentation — read the current file and copy the target text verbatim.` }
    }
    const occurrences = content.split(oldString).length - 1
    if (occurrences > 1 && !replaceAll) {
      return { output: '', error: `old_string matches ${occurrences} places in ${filePath}; the file was NOT modified. Include surrounding context to target a single one, or pass replace_all: true to change all ${occurrences}.` }
    }
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.slice(0, matchIndex) + newString + content.slice(matchIndex + oldString.length)
    await fs.writeFile(abs, updated, 'utf-8')
    const n = replaceAll ? occurrences : 1
    return { output: truncateOutput(`Edited ${filePath} — replaced ${n} occurrence${n === 1 ? '' : 's'}. Updated region:\n${editedRegion(updated, newString, matchIndex)}`, 4000) }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
