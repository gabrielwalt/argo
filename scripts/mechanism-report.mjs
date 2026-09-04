#!/usr/bin/env node
/**
 * mechanism-report.mjs — per-mechanism fires/effectiveness report over Argo's
 * INTERACTIVE JSONL logs.
 *
 * WHY THIS FILE EXISTS. scripts/eval/metrics.mjs already scrapes mechanism counters,
 * but only ever runs inside scripts/eval/e2e.mjs, over eval-battery logs. Gabriel is now
 * using Argo interactively (~/.local/share/argo/logs/<workspace>/*.jsonl, mounted
 * read-only here at /mnt/argo-data/logs/<workspace>/ for the corpus this file was built
 * and validated against) and asked to "keep track of what methods helped or didn't". This
 * is a standalone CLI: point it at the log directory, get a fires + effectiveness table,
 * with no eval harness, no ledger, and no running server required.
 *
 * REUSE, NOT DUPLICATION. The intervention catalogue (WARNING_INTERVENTIONS /
 * REJECTION_INTERVENTIONS / LADDER_FALLBACK), the three error-classification regexes, and
 * metrics.mjs's own self-check are IMPORTED from scripts/eval/metrics.mjs, not
 * re-typed — see the import list below. Everything imported is pure pattern/data, not
 * eval-only machinery: `runMetrics`/`frameOutcomes` (which assume a per-task-run ledger
 * and a `newFiles` snapshot-diff that only make sense inside e2e.mjs's task loop) are
 * DELIBERATELY NOT imported; this file walks the raw event stream itself instead, because
 * an interactive session has no "task run" boundary and no ledger.jsonl in the mounted
 * log directory (that file lives inside the workspace, not under
 * ~/.local/share/argo/logs — see BLIND SPOTS below and MECHANISM-REPORT-NOTES.md).
 *
 * WHAT THIS FILE ADDS beyond metrics.mjs (found reading loop.ts/agent.ts/dispatch.ts
 * directly, dated 2026-09-04, H19-H21 — see MECHANISM-REPORT-NOTES.md for the full
 * account of what changed and why metrics.mjs's own catalogue is partly stale for it):
 *   - the loop ladder's L0 rung now has two forms, 'replay' (serves a cached result,
 *     `tool_result.replayed === true`) and plain 'steer' — distinguished here from the
 *     STRUCTURED field, not by re-parsing prose (loop.ts:604-605, agent.ts:2010-2015).
 *   - L2 has two distinct outcomes that metrics.mjs's `warning.level==='L2'` bump cannot
 *     tell apart: a replan steer (L2_REPLAN_RE) and a 'halt' that ENDS THE FRAME
 *     (LOOP_HALT_RE) — both are logged with `level: 'L2'` (agent.ts:1970 vs :1992), so a
 *     level-only counter conflates "asked to replan" with "the frame just stopped".
 *   - H21 gate-rejection escalation/stop (loop.ts:402/415, agent.ts:736
 *     handleGateRejection): once the SAME (call, gate-reason) pair is refused
 *     `gateEscalateAfter` (3) times running, the rejection's `tool_result.error` text
 *     stops being metrics.mjs's anchored `planGate`/`roleReject` wording and becomes
 *     GATE_ESCALATE_RE/GATE_STOP_RE instead — verified against loop.ts:402-419's literal
 *     construction; not yet observed firing in the corpus this file was built against
 *     (see MECHANISM-REPORT-NOTES.md), so it is reported as a real, source-verified, but
 *     so-far-unfired code path rather than a claim about live data.
 *   - `nearDup` (metrics.mjs's WARNING_INTERVENTIONS entry for the old same-tool-any-args
 *     guard) is DEAD CODE as of the same 2026-09 change (loop.ts's own header comment:
 *     "checkSameToolStreak ... DELETED outright ... 180 firings ... 0 with any observed
 *     effect"). It still matches OLDER log lines (confirmed below), so it is kept here as
 *     a labelled LEGACY pattern, exactly like metrics.mjs's own `legacySteer`/
 *     `legacyPlanGate` — never presented as a live mechanism.
 *
 * VALIDATION. Every pattern below that is not a straight re-export from metrics.mjs was
 * checked against real data with a `jq` query before being written — the query is quoted
 * in the comment next to the pattern it validates, and the corpus + evidence lines are
 * recorded in /shared/argo-program/MECHANISM-REPORT-NOTES.md so the claim is checkable
 * without re-running anything.
 *
 * CLI:
 *   node scripts/mechanism-report.mjs [--ws <workspace>] [--since <ISO date or Nd>]
 *                                     [--run <file.jsonl>] [--json] [--verbose]
 *
 * Env: ARGO_LOG_DIR (default ~/.local/share/argo/logs via os.homedir()),
 *      ARGO_SESSION_GAP_MIN (default 30 — see selectDefaultFiles's doc comment).
 *
 * No npm dependencies; the only imports outside this file are from scripts/eval/metrics.mjs,
 * which is inside this same repo.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
// LADDER_FALLBACK is deliberately NOT imported: it exists in metrics.mjs only to read
// pre-6884852 logs that predate the `warning.level` field, and this file's own header
// comment explains why it is never wired into the matching path here either.
import {
  WARNING_INTERVENTIONS, REJECTION_INTERVENTIONS,
  CAP_HIT_RE, PLANNING_FAILED_RE, UNEXPECTED_ERROR_RE, EVICTION_RE,
  selfCheckCounters,
} from './eval/metrics.mjs'

// ── New patterns, anchored to the exact 2026-09-04 (H21) construction sites ─────────
// Every regex here was checked against its own literal construction in src/ AND against
// the real corpus. See MECHANISM-REPORT-NOTES.md for the jq queries and file names.

// loop.ts:722-729 l0SteerMessage / l0ReplayMessage — both share this lead; the two forms
// are told apart via tool_result.replayed (structured), not by text, so one pattern
// covers both and just marks "this was an L0 firing".
const L0_LEAD_RE = /^You just issued the EXACT same `[^`]+` call that already ran, with nothing changed since/
// loop.ts:745-752 l2ReframeMessage. Confirmed CURRENT wording (checked against
// loop.ts's live source, 2026-09-04): the `(${blocks} consecutive stalled calls now)`
// clause was inserted BETWEEN "without any progress" and the period, which breaks
// metrics.mjs's own LADDER_FALLBACK.loopL2 regex (anchored assuming no such clause) —
// see MECHANISM-REPORT-NOTES.md for why that is not corrected upstream by this file.
const L2_REPLAN_RE = /^You have repeatedly looped on `[^`]+` without any progress \(\d+ consecutive stalled calls now\)\. ABANDON this approach\./
// loop.ts:762-766 lHaltMessage. Confirmed firing for real: grep -l 'STOPPING this frame:
// `read_file` has looped' over /mnt/argo-data/logs/commander/*.jsonl matches
// 2026-09-04T03-39-57_-fix-line-1601-in-parsecommand.jsonl and
// 2026-09-04T03-44-25_verify-this-claim-original-assignment.jsonl (jq -c
// '.event|select(.type=="error")|.message' over both files).
const LOOP_HALT_RE = /^STOPPING this frame: `[^`]+` has looped without progress for \d+ consecutive calls\./
// loop.ts:402-413 gateEscalationMessage. Not yet observed firing in the corpus this file
// was validated against (grep -c 'You have now asked for' over every mounted log = 0) —
// kept anyway because it is a real, live code path (loop.ts:379 noteGateRejection /
// agent.ts:736 handleGateRejection), not a guess about wording that might exist.
const GATE_ESCALATE_RE = /^You have now asked for `[^`]+` \d+ times and been refused every time for the SAME reason\./
// loop.ts:415-419 gateStopMessage. Same not-yet-observed status as GATE_ESCALATE_RE.
const GATE_STOP_RE = /^STOPPING this frame: `[^`]+` has been refused \d+ times in a row by /
// agent.ts:1730-1745 (per-task verify). Two FAIL forms — first-failure and the
// VERIFY_FAIL_ESCALATE+ escalation — and one PASS form. Validated: `jq -c '.event |
// select(.type=="warning") | .message' commander/*.jsonl | grep -c '^Verification for'`
// and `grep -c '^VERIFY PASSED for task'` both > 0 in the corpus (see notes doc for exact
// counts).
const VERIFY_FAIL_FIRST_RE = /^Verification for the current task "([^"]+)" FAILED — command `([^`]+)` did not pass:/
const VERIFY_FAIL_ESCALATED_RE = /^Verification for "([^"]+)" has now FAILED \d+ times in a row \(`([^`]+)`\):/
const VERIFY_PASS_RE = /^VERIFY PASSED for task "([^"]+)" \(`([^`]+)`\)/
// agent.ts's role-frame session-id convention (frames.ts ids are `<role>-<rand>-<n>`),
// same regex metrics.mjs uses internally (FRAME_SESSION_ID) — re-declared here rather
// than imported since metrics.mjs does not export it.
const ROLE_SESSION_RE = /^(planner|implementer|tester|boss)-/
// dispatch.ts's own untagged narrative uses the browser/session id, which is always an
// ISO-ish timestamp with `:`/`.` replaced by `-` (SessionLogger's own filename scheme,
// logger.ts's constructor) — used only to LABEL a row 'dispatch' for readability; nothing
// downstream depends on this being exact.
const DISPATCH_SESSION_RE = /^\d{4}-\d{2}-\d{2}T/

const ARGO_LOG_DIR = process.env.ARGO_LOG_DIR || path.join(os.homedir(), '.local', 'share', 'argo', 'logs')
const SESSION_GAP_MS = Math.max(1, Number(process.env.ARGO_SESSION_GAP_MIN) || 30) * 60 * 1000

// ── CLI args ──────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { ws: null, since: null, run: null, json: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--ws') out.ws = argv[++i]
    else if (a === '--since') out.since = argv[++i]
    else if (a === '--run') out.run = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--verbose') out.verbose = true
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1) }
  }
  return out
}

function printHelp() {
  console.log(`node scripts/mechanism-report.mjs [--ws <workspace>] [--since <ISO date or Nd>] [--run <file.jsonl>] [--json] [--verbose]

Default (no --ws/--since/--run): every workspace under ${ARGO_LOG_DIR}, most recent
session's worth of runs per workspace (a contiguous burst of files with no gap larger
than ${SESSION_GAP_MS / 60000} minutes between consecutive starts — override with
ARGO_SESSION_GAP_MIN, or be exact with --since).`)
}

// Parses "Nd" (N days ago) or an ISO date string. Returns a Date, or null + prints an
// error and exits — a silently-ignored bad --since would produce a report that looks
// complete but scoped wrong, which is worse than refusing to run.
function parseSince(s) {
  const dMatch = /^(\d+)d$/.exec(s)
  if (dMatch) return new Date(Date.now() - Number(dMatch[1]) * 86400000)
  const t = Date.parse(s)
  if (Number.isNaN(t)) {
    console.error(`--since: could not parse "${s}" as an ISO date or "<N>d"`)
    process.exit(1)
  }
  return new Date(t)
}

// ── Discovery ─────────────────────────────────────────────────────────────────────────
function listWorkspaces() {
  try {
    return readdirSync(ARGO_LOG_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch {
    return []
  }
}

function listRunFiles(ws) {
  try {
    return readdirSync(path.join(ARGO_LOG_DIR, ws))
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(ARGO_LOG_DIR, ws, f))
  } catch {
    return []
  }
}

// Best-effort "when did this file start" without fully parsing it — used only for
// selection/sorting, not for the report body (readFileSafe below re-derives everything
// from the actual parsed events). Falls back to mtime when line 0 isn't readable/isn't
// a meta line, which happens for a file killed before its first write completed.
function fileStartTime(file) {
  try {
    const fh = readFileSync(file, 'utf8')
    const nl = fh.indexOf('\n')
    const firstLine = nl === -1 ? fh : fh.slice(0, nl)
    const parsed = JSON.parse(firstLine)
    if (parsed?.event?.type === '__meta__' && parsed.event.startedAt) return new Date(parsed.event.startedAt).getTime()
  } catch { /* fall through to mtime */ }
  try { return statSync(file).mtimeMs } catch { return 0 }
}

// Default selection, per workspace: no ledger, no server, no "session registry" file
// covers frame-tagged logs (registerSession is only ever called for the dispatch's own
// browser session id, per src/server.ts — see this file's header note), so there is no
// authoritative "this is one session" grouping available for role-frame files from the
// log directory alone. The heuristic here is therefore explicitly a CLUSTERING of file
// start times, not a claim about product-level sessions: starting from the single most
// recently started file in the workspace, walk backward through files sorted by start
// time and keep including them as long as the gap to the next-more-recent file is under
// ARGO_SESSION_GAP_MIN; stop at the first larger gap. This is a heuristic for WHICH FILES
// TO SHOW BY DEFAULT, never for effectiveness — pass --since to be exact.
function selectDefaultFiles(ws) {
  const files = listRunFiles(ws).map(f => ({ file: f, time: fileStartTime(f) }))
  if (!files.length) return []
  files.sort((a, b) => b.time - a.time)
  const out = [files[0]]
  for (let i = 1; i < files.length; i++) {
    if (out[out.length - 1].time - files[i].time <= SESSION_GAP_MS) out.push(files[i])
    else break
  }
  return out.map(f => f.file)
}

function selectFiles(opts) {
  if (opts.run) {
    if (existsSync(opts.run)) return [opts.run]
    // Search every mounted workspace for a matching basename, since --run is documented
    // as "<file.jsonl>" (a name), not necessarily a full path.
    for (const ws of listWorkspaces()) {
      const candidate = path.join(ARGO_LOG_DIR, ws, path.basename(opts.run))
      if (existsSync(candidate)) return [candidate]
    }
    console.error(`--run: could not find "${opts.run}" as a path or under any workspace in ${ARGO_LOG_DIR}`)
    process.exit(1)
  }
  const workspaces = opts.ws ? opts.ws.split(',').map(s => s.trim()).filter(Boolean) : listWorkspaces()
  const sinceDate = opts.since ? parseSince(opts.since) : null
  const out = []
  for (const ws of workspaces) {
    const candidates = sinceDate
      ? listRunFiles(ws).filter(f => fileStartTime(f) >= sinceDate.getTime())
      : selectDefaultFiles(ws)
    for (const f of candidates) out.push({ ws, file: f })
  }
  return out
}

// ── Safe JSONL reading — must never crash on a malformed/truncated line ────────────────
function readFileSafe(entry) {
  const { ws, file } = entry
  let raw
  try { raw = readFileSync(file, 'utf8') } catch (err) {
    return { ws, file, meta: {}, timeline: [], skipped: 0, readError: err.message }
  }
  const lines = raw.split('\n')
  let meta = null
  const timeline = []
  let skipped = 0
  for (const line of lines) {
    if (!line.trim()) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { skipped++; continue }
    if (!parsed || typeof parsed !== 'object' || !parsed.event || typeof parsed.event !== 'object') { skipped++; continue }
    if (parsed.event.type === '__meta__') { if (!meta) meta = parsed.event; continue }
    timeline.push({ ts: parsed.ts, seq: parsed.seq, event: parsed.event })
  }
  return { ws, file, meta: meta || {}, timeline, skipped, readError: null }
}

// ── Per-file role / termination classification ──────────────────────────────────────
function roleOf(meta) {
  const sid = meta.sessionId || ''
  const m = ROLE_SESSION_RE.exec(sid)
  if (m) return m[1]
  if (DISPATCH_SESSION_RE.test(sid)) return 'dispatch'
  return sid ? 'unknown' : 'unknown (no sessionId — meta missing or unreadable)'
}

// CRITICAL correctness rule (brief, learned the hard way): read the TERMINAL done/error
// EVENT, never grep the file's text for "Reached maximum iterations" — that string also
// appears quoted INSIDE a later/sibling frame's own objective or message text (the
// dispatch narrative reports what a delegated frame's cap-hit summarized, without the
// dispatch's OWN frame ever emitting an `error` event itself). Verified on real data:
//   for f in commander/*.jsonl; do jq -c 'select(.event.type=="error" or .event.type==
//   "message" or .event.type=="start" or .event.type=="__meta__") | .event' $f; done |
//   grep -c "Reached maximum iterations"   → 136 total, but only 43 are genuine `error`
//   events; 33 are `message`, and 30 each are `__meta__`/`start` (i.e. quoted inside a
//   LATER call's own query/objective text). A whole-file grep would have over-attributed
//   this by roughly 3x and blamed the wrong frames for it.
// meta.durationMs is set ONLY inside SessionLogger.flush() (logger.ts) — its presence is
// therefore the signal that flush() actually completed and the persisted meta line (and,
// by construction, the timeline up to and including a real terminal event) is trustworthy
// rather than a snapshot of a run that is either still in flight or was killed mid-write.
function classifyEnding(rec) {
  const { meta, timeline } = rec
  const flushed = meta.durationMs != null
  const last = timeline.length ? timeline[timeline.length - 1].event : null
  if (!last) {
    return { status: 'no-events', detail: 'file has only a meta line (or nothing parseable) — likely killed at the very start', flushed }
  }
  if (last.type === 'done') {
    return { status: 'done', detail: (last.content || '').slice(0, 160), flushed }
  }
  if (last.type === 'error') {
    const msg = last.message || ''
    let cls = 'other'
    if (CAP_HIT_RE.test(msg)) cls = 'iteration-cap'
    else if (PLANNING_FAILED_RE.test(msg)) cls = 'planning-failed'
    else if (UNEXPECTED_ERROR_RE.test(msg)) cls = 'unexpected-error (crash)'
    else if (LOOP_HALT_RE.test(msg)) cls = 'loop-halt (H21 — no-progress ladder gave up)'
    else if (GATE_STOP_RE.test(msg)) cls = 'gate-stop (H21 — same rejection repeated past the stop bound)'
    return { status: 'error', class: cls, detail: msg.slice(0, 160), flushed }
  }
  // Any other last event type (tool_call/tool_result/warning/iteration/thought/...) with
  // no following done/error means the process ended (killed, crashed the process itself,
  // or is still running) before it could report its own outcome. NOT the same as
  // meta.status — meta.status is set in-MEMORY on every log() call but the persisted
  // meta line on disk is only rewritten at flush(), so a genuinely truncated file can
  // still show a stale meta.status ('running') that agrees with this — but never
  // contradicts a real done/error, since flush() only happens after the run's own
  // try/catch has already emitted one.
  return { status: 'truncated', detail: `last event was '${last.type}' — no done/error event; interactive run was likely killed mid-write`, flushed }
}

// ── Cost / timing per file ───────────────────────────────────────────────────────────
function costOf(rec) {
  let modelCalls = 0, ollamaRetries = 0, auxModelCalls = 0, promptTokens = 0, genTokens = 0
  let objective = null, firstTs = null, lastTs = null
  for (const { ts, event } of rec.timeline) {
    if (firstTs == null) firstTs = ts
    lastTs = ts
    if (event.type === 'ollama_request') modelCalls++
    else if (event.type === 'token_usage') { promptTokens += event.prompt_tokens || 0; genTokens += event.generated_tokens || 0 }
    else if (event.type === 'critic') auxModelCalls++
    else if (event.type === 'warning' && /^Ollama request failed \(/.test(event.message || '')) ollamaRetries++
    else if (objective == null && event.type === 'objective') objective = event.text
    else if (objective == null && event.type === 'start') objective = event.query
  }
  const wallMs = rec.meta.durationMs != null
    ? rec.meta.durationMs
    : (firstTs && lastTs ? new Date(lastTs).getTime() - new Date(firstTs).getTime() : null)
  return {
    modelCallsTotal: modelCalls + ollamaRetries + auxModelCalls,
    modelCalls, ollamaRetries, auxModelCalls, promptTokens, genTokens, wallMs,
    objective: objective || rec.meta.query || null,
  }
}

// ── Mechanism computation ────────────────────────────────────────────────────────────
// Every function below takes the flat list of { ws, file, meta, timeline } records
// selected for this report and returns { fires, ...effectiveness fields, note }.
// "note" is printed verbatim as the reason when effectiveness is n/a — never a
// heuristic dressed up as a number.

// Finds the next REAL tool_call (rejected or not — a rejected retry of the same tool
// counts as "the model tried it again", which is exactly what these checks measure)
// strictly after `fromIdx`, skipping the first `skip` tool_call events encountered (used
// to skip the blocked/replayed call's own echo, which always exists immediately after a
// harness-emitted warning/rejection and always matches by construction).
function nextToolCall(timeline, fromIdx, skip = 0) {
  let seen = 0
  for (let i = fromIdx + 1; i < timeline.length; i++) {
    if (timeline[i].event.type === 'tool_call') {
      if (seen < skip) { seen++; continue }
      return { idx: i, event: timeline[i].event }
    }
  }
  return null
}

function toolResultAt(timeline, idx) {
  for (let i = idx + 1; i < timeline.length; i++) {
    if (timeline[i].event.type === 'tool_result') return timeline[i].event
    if (timeline[i].event.type === 'tool_call') return null // shouldn't happen; be safe
  }
  return null
}

// Loop ladder — L0 (steer/replay), L1 (compact), L2 (replan vs halt). Field-first
// (warning.level), per the brief's own rule ("Ladder rungs must be read from the
// warning.level FIELD, never from prose") — LADDER_FALLBACK (imported, unused for
// matching here) exists in metrics.mjs only for logs written before the field existed;
// every file this tool has been run against carries the field, so the fallback is not
// wired in here at all — a log old enough to need it would show as 0 ladder fires plus
// unclassified prose in the warnUnmatched corpus scan (see selfCheck below), which is
// the correct, visible failure mode rather than a silent misattribution.
function computeLoopLadder(records) {
  const rows = {
    L0: { fires: 0, replay: 0, steer: 0, sameToolNext: 0, differentToolNext: 0, noNextCall: 0 },
    L1: { fires: 0, sameToolNext: 0, differentToolNext: 0, noNextCall: 0 },
    L2_replan: { fires: 0, nextIsUpdatePlan: 0, nextIsSameTool: 0, nextIsOther: 0, noNextCall: 0 },
    L2_halt: { fires: 0 },
  }
  for (const rec of records) {
    const tl = rec.timeline
    for (let i = 0; i < tl.length; i++) {
      const e = tl[i].event
      if (e.type !== 'warning' || !e.level) continue
      const toolMatch = /`([^`]+)`/.exec(e.message || '')
      const triggeringTool = toolMatch ? toolMatch[1] : null
      if (e.level === 'L0' && L0_LEAD_RE.test(e.message || '')) {
        rows.L0.fires++
        const echoResult = toolResultAt(tl, i + 1) // the blocked call's own tool_result
        if (echoResult && echoResult.replayed === true) rows.L0.replay++
        else rows.L0.steer++
        const nxt = nextToolCall(tl, i, 1)
        if (!nxt) rows.L0.noNextCall++
        else if (nxt.event.tool === triggeringTool) rows.L0.sameToolNext++
        else rows.L0.differentToolNext++
      } else if (e.level === 'L1') {
        rows.L1.fires++
        const nxt = nextToolCall(tl, i, 1)
        if (!nxt) rows.L1.noNextCall++
        else if (nxt.event.tool === triggeringTool) rows.L1.sameToolNext++
        else rows.L1.differentToolNext++
      } else if (e.level === 'L2' && LOOP_HALT_RE.test(e.message || '')) {
        rows.L2_halt.fires++ // by construction the frame ends right here — no "next" to inspect
      } else if (e.level === 'L2') {
        // L2_REPLAN_RE is checked but not required to match — the wording is prose and
        // could drift; still counted as an L2-replan by ELIMINATION (level L2, not a
        // halt), with the regex match recorded only as a corroboration flag for the
        // self-check below, per the brief's "field first" rule.
        rows.L2_replan.fires++
        const nxt = nextToolCall(tl, i, 1)
        if (!nxt) rows.L2_replan.noNextCall++
        else if (nxt.event.tool === 'update_plan') rows.L2_replan.nextIsUpdatePlan++
        else if (nxt.event.tool === triggeringTool) rows.L2_replan.nextIsSameTool++
        else rows.L2_replan.nextIsOther++
      }
    }
  }
  return rows
}

// Gate rejections: role gate / plan-act gate (REJECTION_INTERVENTIONS, imported), plus
// the H21 escalation/stop wording that supersedes their plain text after
// gateEscalateAfter (3) identical refusals — see this file's header comment.
function computeGateRejections(records) {
  const rows = {
    planGate: { fires: 0, sameCallNext: 0, differentNext: 0, noNextCall: 0 },
    roleReject: { fires: 0, sameToolNext: 0, differentToolNext: 0, noNextCall: 0 },
    loopSkip: { fires: 0 }, // the L0/halt "SKIPPED — identical..." rejection text; see computeLoopLadder for the ladder-level breakdown this duplicates by design (REJECTION_INTERVENTIONS' own key)
    gateEscalate: { fires: 0 },
    gateStop: { fires: 0 },
    rejectedUnclassified: 0,
  }
  for (const rec of records) {
    const tl = rec.timeline
    for (let i = 0; i < tl.length; i++) {
      const e = tl[i].event
      if (e.type !== 'tool_result' || e.rejected !== true) continue
      const msg = e.error || ''
      if (GATE_ESCALATE_RE.test(msg)) { rows.gateEscalate.fires++; continue }
      if (GATE_STOP_RE.test(msg)) { rows.gateStop.fires++; continue }
      const hit = REJECTION_INTERVENTIONS.find(s => s.re.test(msg))
      if (!hit) { rows.rejectedUnclassified++; continue }
      if (hit.key === 'loopSkip') { rows.loopSkip.fires++; continue }
      if (hit.key === 'planGate') {
        rows.planGate.fires++
        const nxt = nextToolCall(tl, i - 1, 0) // i-1: tool_call for this rejection sits at i-1
        if (!nxt) rows.planGate.noNextCall++
        else if (nxt.event.tool === 'update_plan') rows.planGate.differentNext++
        else rows.planGate.sameCallNext++
      } else if (hit.key === 'roleReject') {
        rows.roleReject.fires++
        const toolMatch = /^tool "([^"]+)"/.exec(msg)
        const rejectedTool = toolMatch ? toolMatch[1] : null
        const nxt = nextToolCall(tl, i - 1, 0)
        if (!nxt) rows.roleReject.noNextCall++
        else if (nxt.event.tool === rejectedTool) rows.roleReject.sameToolNext++
        else rows.roleReject.differentToolNext++
      }
    }
  }
  return rows
}

// Executable per-task verify (agent.ts ~1720-1745). For each FAIL, classify the very
// next tool_call as: a mutation (edit_file/write_file — a genuine fix attempt), a bash
// call running the EXACT same verify command again (the harness itself re-runs it
// automatically the next time the model claims to be done — this is "identical failure
// again" without the model even having to ask), or something else (exploration).
function computeVerify(records) {
  const row = { pass: 0, fail: 0, failThenMutation: 0, failThenSameVerifyRerun: 0, failThenOther: 0, failThenNoNextCall: 0 }
  for (const rec of records) {
    const tl = rec.timeline
    for (let i = 0; i < tl.length; i++) {
      const e = tl[i].event
      if (e.type !== 'warning') continue
      const msg = e.message || ''
      if (VERIFY_PASS_RE.test(msg)) { row.pass++; continue }
      const failMatch = VERIFY_FAIL_FIRST_RE.exec(msg) || VERIFY_FAIL_ESCALATED_RE.exec(msg)
      if (!failMatch) continue
      row.fail++
      const verifyCmd = failMatch[2]
      const nxt = nextToolCall(tl, i, 0)
      if (!nxt) { row.failThenNoNextCall++; continue }
      if (nxt.event.tool === 'edit_file' || nxt.event.tool === 'write_file') row.failThenMutation++
      else if (nxt.event.tool === 'bash' && nxt.event.args && nxt.event.args.command === verifyCmd) row.failThenSameVerifyRerun++
      else row.failThenOther++
    }
  }
  return row
}

// Task gate round trips: summaryAsk + taskAdvance + reconcile + reground (agent.ts
// ~1751/1774/1801/1851). Every one of these is BY CONSTRUCTION a forced extra model turn
// (the harness pushes the message and `continue`s the SAME run) — "fires" and "forced
// round trips" are therefore the same count, not two independently observable things; see
// MECHANISM-REPORT-NOTES.md for why this file does not manufacture a second number here.
function computeGateRoundTrips(records) {
  const keys = ['summaryAsk', 'taskAdvance', 'reconcile', 'reground']
  const specs = keys.map(k => WARNING_INTERVENTIONS.find(s => s.key === k))
  const counts = Object.fromEntries(keys.map(k => [k, 0]))
  for (const rec of records) {
    for (const { event } of rec.timeline) {
      if (event.type !== 'warning') continue
      for (const spec of specs) if (spec.re.test(event.message || '')) counts[spec.key]++
    }
  }
  const total = keys.reduce((a, k) => a + counts[k], 0)
  return { ...counts, total }
}

// Actor-critic checkpoints (types.ts's `critic` event — post-plan/on-stall/pre-done,
// plus grounding/layout which reuse the same shape, checkpoint: 'grounding'|'layout').
// Fully STRUCTURED — no regex, cannot rot the way a prose counter can. Reported per
// checkpoint since a 'grounding'/'layout' verdict:'ok' produces NO warning at all
// (agent.ts only emits the steer warning on 'revise'), so metrics.mjs's own
// groundingRevise/layoutRevise prose counters structurally cannot see the 'ok' side —
// this is a real gap in metrics.mjs, reported in MECHANISM-REPORT-NOTES.md.
function computeCritic(records) {
  const byCheckpoint = {}
  for (const rec of records) {
    for (const { event } of rec.timeline) {
      if (event.type !== 'critic') continue
      const c = byCheckpoint[event.checkpoint] ??= { ok: 0, revise: 0, gamedOracle: 0 }
      if (event.verdict === 'ok') c.ok++
      else if (event.verdict === 'revise') c.revise++
      if (event.gamed_oracle) c.gamedOracle++
    }
  }
  return byCheckpoint
}

// Stall / progress-check / no-progress re-ground nudges (agent.ts stall() and
// regroundSteer()). Effectiveness signal available from the log: did a project mutation
// (edit_file/write_file) happen before the NEXT nudge of the SAME kind (or a done event)?
// If yes, call it "followed by an edit"; if the model just produced ANOTHER identical-kind
// nudge with no mutation in between, call it "repeated with no edit in between".
function computeStallNudges(records) {
  const kinds = {
    stall: WARNING_INTERVENTIONS.find(s => s.key === 'stall').re,
    progressCheck: WARNING_INTERVENTIONS.find(s => s.key === 'progressCheck').re,
    noProgress: WARNING_INTERVENTIONS.find(s => s.key === 'noProgress').re,
  }
  const rows = Object.fromEntries(Object.keys(kinds).map(k => [k, { fires: 0, followedByEdit: 0, repeatedNoEdit: 0, endedRun: 0, other: 0 }]))
  for (const rec of records) {
    const tl = rec.timeline
    for (let i = 0; i < tl.length; i++) {
      const e = tl[i].event
      if (e.type !== 'warning') continue
      const kind = Object.keys(kinds).find(k => kinds[k].test(e.message || ''))
      if (!kind) continue
      rows[kind].fires++
      let sawMutation = false, sawSameKindAgain = false, sawDone = false
      for (let j = i + 1; j < tl.length; j++) {
        const ev = tl[j].event
        if (ev.type === 'tool_call' && (ev.tool === 'edit_file' || ev.tool === 'write_file')) { sawMutation = true; break }
        if (ev.type === 'done') { sawDone = true; break }
        if (ev.type === 'warning' && kinds[kind].test(ev.message || '')) { sawSameKindAgain = true; break }
      }
      if (sawMutation) rows[kind].followedByEdit++
      else if (sawSameKindAgain) rows[kind].repeatedNoEdit++
      else if (sawDone) rows[kind].endedRun++
      else rows[kind].other++
    }
  }
  return rows
}

// Eviction vs LLM compaction — both share the `compact` event; EVICTION_RE (imported)
// distinguishes them by summary text (agent.ts:663, same test metrics.mjs uses).
function computeCompaction(records) {
  const row = { eviction: 0, llmCompaction: 0, compactStart: 0, compactFailed: 0 }
  for (const rec of records) {
    for (const { event } of rec.timeline) {
      if (event.type === 'compact') { if (EVICTION_RE.test(event.summary || '')) row.eviction++; else row.llmCompaction++ }
      else if (event.type === 'compact_start') row.compactStart++
      else if (event.type === 'warning' && /^(Context compaction failed|Loop-recovery compaction failed)/.test(event.message || '')) row.compactFailed++
    }
  }
  return row
}

// Remaining catalogued WARNING/REJECTION patterns not given a bespoke effectiveness
// treatment above — reported as fires-only. Includes the schema-extraction recovery
// family, plannerFormatRetry, testerNoVerdict, memoryFiltered, ollamaRetry, infraWarn,
// and the two LEGACY patterns (nearDup, legacySteer, legacyPlanGate) — legacy ones
// labelled explicitly so a reader never mistakes a historical-log match for a live
// mechanism firing today.
const LEGACY_WARNING_KEYS = new Set(['nearDup', 'legacySteer', 'legacyPlanGate'])
const BESPOKE_WARNING_KEYS = new Set(['stall', 'progressCheck', 'noProgress', 'verifyFail', 'verifyPass', 'summaryAsk', 'taskAdvance', 'reconcile', 'reground', 'criticRevise', 'groundingRevise', 'layoutRevise'])
function computeFiresOnly(records) {
  const counts = Object.fromEntries(WARNING_INTERVENTIONS.map(s => [s.key, 0]))
  const rejectionCounts = Object.fromEntries(REJECTION_INTERVENTIONS.map(s => [s.key, 0]))
  let warnUnmatched = 0, rejectedUnclassifiedText = 0
  const unmatchedSamples = new Set()
  for (const rec of records) {
    for (const { event } of rec.timeline) {
      if (event.type === 'warning') {
        const msg = event.message || ''
        if (event.level) continue // ladder rungs are handled structurally, not via prose here
        const hit = WARNING_INTERVENTIONS.find(s => s.re.test(msg))
        if (hit) counts[hit.key]++
        else { warnUnmatched++; if (unmatchedSamples.size < 8) unmatchedSamples.add(msg.slice(0, 70)) }
      } else if (event.type === 'tool_result' && event.rejected === true) {
        const msg = event.error || ''
        if (GATE_ESCALATE_RE.test(msg) || GATE_STOP_RE.test(msg)) continue // counted in computeGateRejections
        const hit = REJECTION_INTERVENTIONS.find(s => s.re.test(msg))
        if (hit) rejectionCounts[hit.key]++
        else rejectedUnclassifiedText++
      }
    }
  }
  return { counts, rejectionCounts, warnUnmatched, unmatchedSamples: [...unmatchedSamples], rejectedUnclassifiedText }
}

// Structured, ledger-free harness narrative counters: tasks (planned/replanned/advanced),
// boss_verdict (inject/restart/escalate), replan, task_graph width. Fires-only — "did it
// help" needs the ledger's conclusion/delegation entries (which frame followed, with what
// status), and that file is NOT in the mounted log directory (see BLIND SPOTS).
function computeStructuredNarrative(records) {
  const row = {
    tasksPlanned: 0, tasksReplanned: 0, tasksAdvanced: 0,
    bossInject: 0, bossRestart: 0, bossEscalate: 0, dispatchReplan: 0,
    taskGraphs: 0, taskGraphMaxSteps: 0, taskGraphSingleStep: 0,
  }
  for (const rec of records) {
    for (const { event } of rec.timeline) {
      if (event.type === 'tasks') {
        if (event.action === 'planned') row.tasksPlanned++
        else if (event.action === 'replanned') row.tasksReplanned++
        else if (event.action === 'advanced') row.tasksAdvanced++
      } else if (event.type === 'boss_verdict') {
        if (event.action === 'inject') row.bossInject++
        else if (event.action === 'restart') row.bossRestart++
        else if (event.action === 'escalate') row.bossEscalate++
      } else if (event.type === 'replan') row.dispatchReplan++
      else if (event.type === 'task_graph' && Array.isArray(event.steps)) {
        row.taskGraphs++
        row.taskGraphMaxSteps = Math.max(row.taskGraphMaxSteps, event.steps.length)
        if (event.steps.length <= 1) row.taskGraphSingleStep++
      }
    }
  }
  return row
}

// ── Self-check ────────────────────────────────────────────────────────────────────────
// Two DIFFERENT kinds of check, deliberately not conflated (see the header comment):
//   1. Pattern SELF-test — every pattern (imported + new) must match its own literal
//      construction sample. Mirrors metrics.mjs's selfCheckCounters() exactly; the new
//      patterns get the same treatment inline below.
//   2. Corpus COVERAGE — for every catalogued pattern, did it fire at least once in the
//      corpus actually scanned this run? A pattern with 0 fires is NOT reported as
//      broken (many mechanisms are legitimately off — critic/schema-control-plane/H21
//      escalation are 0 in most real corpora) — it is reported so a reader knows this
//      run did NOT corroborate that pattern against live wording, which is a weaker
//      claim than "verified" and is stated as exactly that, no stronger.
// A THIRD, sharper signal — `warnUnmatched`/`rejectedUnclassifiedText` above — is a real
// message that matched NO pattern at all; that one IS a tripwire (mirrors metrics.mjs's
// own warnUnmatched/errorsOther) and is reported separately, in the report body, not here.
function selfCheck(records) {
  const failures = []
  const base = selfCheckCounters()
  if (!base.ok) failures.push(...base.failures.map(f => `[metrics.mjs] ${f}`))

  const ownSamples = [
    { name: 'L0_LEAD_RE', re: L0_LEAD_RE, sample: 'You just issued the EXACT same `bash` call that already ran, with nothing changed since. STOP repeating it — take a DIFFERENT concrete action toward the current task, or, if it is truly already done, say so.' },
    { name: 'L2_REPLAN_RE', re: L2_REPLAN_RE, sample: 'You have repeatedly looped on `bash` without any progress (6 consecutive stalled calls now). ABANDON this approach. Produce a revised plan now for solving the current task a different way.' },
    { name: 'LOOP_HALT_RE', re: LOOP_HALT_RE, sample: 'STOPPING this frame: `read_file` has looped without progress for 10 consecutive calls. The request to abandon this approach and call update_plan was already given and ignored. Continuing would only repeat the same failed recovery.' },
    { name: 'GATE_ESCALATE_RE', re: GATE_ESCALATE_RE, sample: 'You have now asked for `bash` 3 times and been refused every time for the SAME reason. It will keep being refused. Do NOT retry `bash` yet.' },
    { name: 'GATE_STOP_RE', re: GATE_STOP_RE, sample: 'STOPPING this frame: `bash` has been refused 6 times in a row by the plan-before-mutation gate, with no progress. Continuing would only repeat the same refusal.' },
    { name: 'VERIFY_FAIL_FIRST_RE', re: VERIFY_FAIL_FIRST_RE, sample: 'Verification for the current task "Implement addTask" FAILED — command `npm test` did not pass:\noutput' },
    { name: 'VERIFY_FAIL_ESCALATED_RE', re: VERIFY_FAIL_ESCALATED_RE, sample: 'Verification for "Implement addTask" has now FAILED 3 times in a row (`npm test`):\noutput' },
    { name: 'VERIFY_PASS_RE', re: VERIFY_PASS_RE, sample: 'VERIFY PASSED for task "Implement addTask" (`npm test`) — capturing a summary before advancing.' },
  ]
  for (const s of ownSamples) if (!s.re.test(s.sample)) failures.push(`[mechanism-report] ${s.name}: pattern does not match its own construction sample`)

  // Corpus coverage — informational, not appended to `failures` (which is reserved for
  // "this pattern is provably wrong"). Returned separately so the caller can label it
  // distinctly from a real self-test failure.
  const allWarningKeys = WARNING_INTERVENTIONS.map(s => s.key)
  const allRejectionKeys = REJECTION_INTERVENTIONS.map(s => s.key)
  const firesOnly = computeFiresOnly(records)
  const ladder = computeLoopLadder(records)
  const gate = computeGateRejections(records)
  const verify = computeVerify(records)
  const coverage = []
  for (const k of allWarningKeys) if ((firesOnly.counts[k] || 0) === 0) coverage.push(`warning.${k}`)
  for (const k of allRejectionKeys) if ((firesOnly.rejectionCounts[k] || 0) === 0) coverage.push(`rejection.${k}`)
  if (ladder.L0.fires === 0) coverage.push('ladder.L0')
  if (ladder.L1.fires === 0) coverage.push('ladder.L1')
  if (ladder.L2_replan.fires === 0) coverage.push('ladder.L2_replan')
  if (ladder.L2_halt.fires === 0) coverage.push('ladder.L2_halt')
  if (gate.gateEscalate.fires === 0) coverage.push('gate.gateEscalate')
  if (gate.gateStop.fires === 0) coverage.push('gate.gateStop')
  if (verify.pass === 0) coverage.push('verify.pass')
  if (verify.fail === 0) coverage.push('verify.fail')

  return { ok: failures.length === 0, failures, coverage, corpusFiles: records.length }
}

// ── Blind spots ───────────────────────────────────────────────────────────────────────
// Mechanisms that emit NOTHING at all — verified against the CURRENT source at the paths
// cited, not assumed from the brief. Silence from these must never be read as "did not
// fire"; there is no way to tell from the log.
const BLIND_SPOTS = [
  {
    mechanism: 'Plan recitation (renderTaskLedger / renderPlanReminder tail-of-context injection)',
    src: 'src/agent.ts:1038-1046 (chatCall) — pushes the recited ledger/plan reminder onto `messages` via `messages.push(...)`; no `emitAndLog` call anywhere in that block.',
    verified: 'grep -n "renderTaskLedger\\|renderPlanReminder" src/agent.ts — both call sites are messages.push only.',
  },
  {
    mechanism: 'AGENTS.md section selection (selectAgentsSections, this.memory path)',
    src: 'src/agent.ts:1057-1066 — `selectAgentsSections(...)`, result pushed via `messages.push`; no event.',
    verified: 'grep -n "selectAgentsSections" src/*.ts — defined in memory.ts, called only from agent.ts, no logger/emit call in either file.',
  },
  {
    mechanism: 'MEMORY.md retrieval (selectMemoryEntries, this.memory path)',
    src: 'src/agent.ts:1048-1055 — `selectMemoryEntries(...)`, result pushed via `messages.push`; no event.',
    verified: 'grep -n "selectMemoryEntries" src/*.ts — same as above, memory.ts has zero emit/log call sites (grep -n "emitAndLog\\|emit(" src/memory.ts returns nothing).',
  },
  {
    mechanism: 'renderPinnedAnchor (src/eviction.ts:70)',
    src: 'src/eviction.ts:70 — defined, exported, never called anywhere else in src/.',
    verified: 'grep -rn "renderPinnedAnchor" src/*.ts — only the one definition line; genuinely dead code, not merely unlogged. Re-verified for THIS run of the tool, per the brief\'s instruction to check it has not gained a call site.',
  },
  {
    mechanism: 'Boss task-start marker retry, non-schema path (dispatch.ts\'s plain resumeFrame(TASK_START_MARKER_RETRY_NUDGE) branch)',
    src: 'src/dispatch.ts:~397-419 — when config.schemaControlPlane is OFF, an unparsed ANSWER/TRIVIAL/SIMPLE/OBJECTIVE marker is retried via a bare resumeFrame call with no event at all; only the schemaControlPlane-ON sibling branch (the schema-extraction rescue) emits a `warning`.',
    verified: 'Found by this tool\'s author, not in the original brief — confirmed against a real firing: /mnt/argo-data/logs/test-wind/2026-09-04T07-06-48_your-last-answer-didn-t-end-with-one-of.jsonl is exactly this retry (query text is TASK_START_MARKER_RETRY_NUDGE verbatim); no warning event marks it anywhere in that session\'s files. See MECHANISM-REPORT-NOTES.md.',
  },
]

// ── Rendering ─────────────────────────────────────────────────────────────────────────
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length) }
function fmtMs(ms) { return ms == null ? '?' : `${Math.round(ms / 1000)}s` }

function renderInventory(rowsData, verbose) {
  console.log('\n=== 1. RUN INVENTORY ===\n')
  console.log(pad('workspace', 14) + pad('started', 21) + pad('role', 12) + pad('ended', 9) + pad('calls', 6) + pad('tok in/out', 14) + pad('wall', 7) + 'objective / ending detail')
  for (const r of rowsData) {
    const objective = (r.cost.objective || '').replace(/\s+/g, ' ').slice(0, verbose ? 400 : 70)
    console.log(
      pad(r.ws, 14) + pad(r.meta.startedAt ? r.meta.startedAt.slice(0, 19) : '?', 21)
      + pad(r.role, 12) + pad(r.ending.status, 9) + pad(r.cost.modelCallsTotal, 6)
      + pad(`${r.cost.promptTokens}/${r.cost.genTokens}`, 14) + pad(fmtMs(r.cost.wallMs), 7)
      + objective,
    )
    if (r.ending.status === 'error') console.log(`      error class: ${r.ending.class} — ${r.ending.detail}`)
    if (r.ending.status === 'truncated') console.log(`      ${r.ending.detail}`)
    if (r.skipped) console.log(`      !! ${r.skipped} malformed/unparseable line(s) skipped in this file`)
    if (r.taskGraphSteps != null) console.log(`      task_graph: ${r.taskGraphSteps} step(s) declared (delegation tree beyond this is not reconstructable without .argo/ledger.jsonl — see BLIND SPOTS)`)
  }
}

function renderMechanisms(m) {
  console.log('\n=== 2. MECHANISM TABLE ===\n')

  console.log('-- Loop-recovery ladder (field: warning.level; src loop.ts) --')
  console.log(`L0 steer/replay:  fires=${m.ladder.L0.fires}  (replay=${m.ladder.L0.replay}, plain steer=${m.ladder.L0.steer})`)
  console.log(`  next call: same tool again=${m.ladder.L0.sameToolNext}  different tool=${m.ladder.L0.differentToolNext}  no further call in file=${m.ladder.L0.noNextCall}`)
  console.log(`  effectiveness precedent (prior hand-analysis corpus): "same tool again" fires were 180/180 — L0 fires but does not change the immediate next action; the numbers above are this run's own version of that same measurement, not an assumed repeat of it.`)
  console.log(`L1 compact+steer: fires=${m.ladder.L1.fires}`)
  console.log(`  next call: same tool again=${m.ladder.L1.sameToolNext}  different tool=${m.ladder.L1.differentToolNext}  no further call in file=${m.ladder.L1.noNextCall}`)
  console.log(`L2 replan:        fires=${m.ladder.L2_replan.fires}`)
  console.log(`  next call: update_plan (intended reaction)=${m.ladder.L2_replan.nextIsUpdatePlan}  same tool again=${m.ladder.L2_replan.nextIsSameTool}  other=${m.ladder.L2_replan.nextIsOther}  no further call=${m.ladder.L2_replan.noNextCall}`)
  console.log(`L2 halt (frame stopped): fires=${m.ladder.L2_halt.fires}  — n/a for "next action": the frame ends at this event by construction (agent.ts endFrameStalled), there is no next turn in this file to inspect.`)

  console.log('\n-- Tool-rejection surfacing (tool_result.rejected===true; src agent.ts rejectToolCall + H21) --')
  console.log(`role gate:  fires=${m.gate.roleReject.fires}  next call same forbidden tool=${m.gate.roleReject.sameToolNext}  different tool=${m.gate.roleReject.differentToolNext}  no further call=${m.gate.roleReject.noNextCall}`)
  console.log(`plan/act gate: fires=${m.gate.planGate.fires}  next call is update_plan (intended)=${m.gate.planGate.differentNext}  same mutation retried=${m.gate.planGate.sameCallNext}  no further call=${m.gate.planGate.noNextCall}`)
  console.log(`loop-ladder SKIPPED rejection (duplicate of ladder L0/halt's own tool_result — see above): fires=${m.gate.loopSkip.fires}`)
  console.log(`H21 gate escalation wording (3rd+ identical refusal): fires=${m.gate.gateEscalate.fires}${m.gate.gateEscalate.fires === 0 ? '  (not observed in this corpus — see MECHANISM-REPORT-NOTES.md; this is a real, unfired code path, not "n/a")' : ''}`)
  console.log(`H21 gate stop (frame ended by repeated-rejection bound): fires=${m.gate.gateStop.fires}${m.gate.gateStop.fires === 0 ? '  (not observed in this corpus)' : ''}`)
  if (m.gate.rejectedUnclassified) console.log(`  !! ${m.gate.rejectedUnclassified} rejected tool_result(s) matched NO known rejection pattern — see warnUnmatched-style tripwire in the self-check section`)

  console.log('\n-- Executable per-task verify (src agent.ts ~1720-1745, config.tasks / Implementer role only) --')
  console.log(`pass=${m.verify.pass}  fail=${m.verify.fail}`)
  console.log(`  fail then: mutation attempted (edit_file/write_file)=${m.verify.failThenMutation}  same verify command re-run with no edit in between=${m.verify.failThenSameVerifyRerun}  other action=${m.verify.failThenOther}  no further call in file=${m.verify.failThenNoNextCall}`)

  console.log('\n-- Task gate round trips (summaryAsk + taskAdvance + reconcile + reground; src agent.ts) --')
  console.log(`summaryAsk=${m.gateRT.summaryAsk}  taskAdvance=${m.gateRT.taskAdvance}  reconcile=${m.gateRT.reconcile}  reground=${m.gateRT.reground}  TOTAL=${m.gateRT.total}`)
  console.log('  n/a beyond the count above: each of these IS a forced round trip by construction (the harness pushes a message and continues the same run) — "fires" and "became a forced round trip" are the same number here, not two independent signals.')

  console.log('\n-- Grounding guard (critic event, checkpoint=grounding; structured, src grounding.ts/agent.ts) --')
  const g = m.critic.grounding || { ok: 0, revise: 0, gamedOracle: 0 }
  console.log(`ok=${g.ok}  revise=${g.revise}  gamed_oracle flagged=${g.gamedOracle}`)

  console.log('\n-- Layout judge (critic event, checkpoint=layout) --')
  const lay = m.critic.layout || { ok: 0, revise: 0, gamedOracle: 0 }
  console.log(`ok=${lay.ok}  revise=${lay.revise}`)

  console.log('\n-- Actor-critic checkpoints (post-plan / on-stall / pre-done; config.critic) --')
  for (const cp of ['post-plan', 'on-stall', 'pre-done']) {
    const c = m.critic[cp] || { ok: 0, revise: 0, gamedOracle: 0 }
    console.log(`  ${cp}: ok=${c.ok}  revise=${c.revise}  gamed_oracle=${c.gamedOracle}`)
  }
  console.log('  n/a for downstream effectiveness: a revise injects a steer (same shape as the stall/reground nudges below) but this tool does not have a task-success oracle to compare against — only "did the model act (edit) before finishing" is checkable, and config.critic is off in most captured runs (0 events is the expected, not broken, result).')

  console.log('\n-- Stall / progress-check / no-progress re-ground nudges (src agent.ts) --')
  for (const k of ['stall', 'progressCheck', 'noProgress']) {
    const r = m.stallNudges[k]
    console.log(`  ${k}: fires=${r.fires}  followed by an edit=${r.followedByEdit}  repeated (same kind, no edit in between)=${r.repeatedNoEdit}  run ended next=${r.endedRun}  other=${r.other}`)
  }

  console.log('\n-- Eviction / compaction (src agent.ts:663, `compact` event; EVICTION_RE from metrics.mjs) --')
  console.log(`deterministic eviction=${m.compaction.eviction}  LLM compaction=${m.compaction.llmCompaction}  compact_start=${m.compaction.compactStart}  compaction attempt failed=${m.compaction.compactFailed}`)
  console.log('  n/a for effectiveness: nothing in the interactive log records whether the run would have failed WITHOUT the compaction — there is no held-out "same run, no compaction" comparison available from a log alone.')

  console.log('\n-- Structured harness narrative (tasks / boss_verdict / replan / task_graph — no regex) --')
  console.log(`tasks: planned=${m.narrative.tasksPlanned}  replanned=${m.narrative.tasksReplanned}  advanced=${m.narrative.tasksAdvanced}`)
  console.log(`boss_verdict: inject=${m.narrative.bossInject}  restart=${m.narrative.bossRestart}  escalate=${m.narrative.bossEscalate}`)
  console.log(`dispatch replan=${m.narrative.dispatchReplan}  task_graph count=${m.narrative.taskGraphs}  max steps seen=${m.narrative.taskGraphMaxSteps}  single-step graphs=${m.narrative.taskGraphSingleStep}`)
  console.log('  n/a for effectiveness: a boss_verdict inject/restart/escalate changes what a DIFFERENT frame (targetFrameId) does next, and that frame\'s own log is a SEPARATE file this tool would need the ledger to link to — not attempted here (see BLIND SPOTS).')

  console.log('\n-- Other catalogued warnings/rejections, fires-only (schema-extraction recovery, planner format retry, tester no-verdict, memory filter, ollama retry, infra warnings) --')
  for (const key of WARNING_INTERVENTIONS.map(s => s.key)) {
    if (BESPOKE_WARNING_KEYS.has(key)) continue
    const n = m.firesOnly.counts[key] || 0
    const tag = LEGACY_WARNING_KEYS.has(key) ? '  [LEGACY — mechanism removed from src/, pattern kept only for older logs; see header comment]' : ''
    if (n > 0 || LEGACY_WARNING_KEYS.has(key)) console.log(`  ${key}: ${n}${tag}`)
  }
  if (m.firesOnly.warnUnmatched) console.log(`  !! ${m.firesOnly.warnUnmatched} warning message(s) matched NO catalogued pattern at all: ${JSON.stringify(m.firesOnly.unmatchedSamples)}`)
  if (m.firesOnly.rejectedUnclassifiedText) console.log(`  !! ${m.firesOnly.rejectedUnclassifiedText} rejected tool_result(s) with unclassified error text`)
}

function renderBlindSpots() {
  console.log('\n=== 3. BLIND SPOTS — mechanisms that emit NOTHING; silence here never means "did not fire" ===\n')
  for (const b of BLIND_SPOTS) {
    console.log(`- ${b.mechanism}`)
    console.log(`    src: ${b.src}`)
    console.log(`    verified: ${b.verified}`)
  }
  console.log('\n  Also structurally blind to THIS tool (not to the harness — the events exist, just not in the mounted directory):')
  console.log('    delegation tree (which frame spawned which, boss_verdict targets, standup coverage) — lives only in .argo/ledger.jsonl')
  console.log('    inside the WORKSPACE, which is not part of ~/.local/share/argo/logs and is not mounted for this tool. See MECHANISM-REPORT-NOTES.md.')
}

function renderSelfCheck(sc) {
  console.log('\n=== SELF-CHECK ===\n')
  if (!sc.ok) {
    console.error('!!! PATTERN SELF-TEST FAILED — a pattern below does not match its own construction sample. Fires computed from it are NOT trustworthy:')
    for (const f of sc.failures) console.error(`    ${f}`)
  } else {
    console.log(`Pattern self-test: OK (${WARNING_INTERVENTIONS.length + REJECTION_INTERVENTIONS.length + 8} patterns checked against their own construction samples).`)
  }
  console.log(`Corpus scanned: ${sc.corpusFiles} file(s).`)
  if (sc.coverage.length) {
    console.log(`Corpus coverage: ${sc.coverage.length} catalogued pattern(s) fired ZERO times in this run's corpus (NOT necessarily broken — many mechanisms are legitimately off; this only means this run did not corroborate the pattern against live wording):`)
    for (const c of sc.coverage) console.log(`    UNMATCHED PATTERN: ${c}`)
  } else {
    console.log('Corpus coverage: every catalogued pattern fired at least once in this corpus.')
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv.slice(2))
  const selection = selectFiles(opts)
  if (!selection.length) {
    console.error(`No log files selected under ${ARGO_LOG_DIR}${opts.ws ? ` for workspace(s) ${opts.ws}` : ''}. Check ARGO_LOG_DIR and --ws/--since/--run.`)
    process.exit(1)
  }

  const records = selection.map(readFileSafe)
  const totalSkipped = records.reduce((a, r) => a + r.skipped, 0)

  const inventoryRows = records.map(rec => {
    const ending = classifyEnding(rec)
    const cost = costOf(rec)
    const tg = rec.timeline.find(t => t.event.type === 'task_graph')
    return {
      ws: rec.ws, file: rec.file, meta: rec.meta, role: roleOf(rec.meta), ending, cost,
      skipped: rec.skipped,
      taskGraphSteps: tg ? tg.event.steps.length : null,
    }
  })

  const mechanisms = {
    ladder: computeLoopLadder(records),
    gate: computeGateRejections(records),
    verify: computeVerify(records),
    gateRT: computeGateRoundTrips(records),
    critic: computeCritic(records),
    stallNudges: computeStallNudges(records),
    compaction: computeCompaction(records),
    narrative: computeStructuredNarrative(records),
    firesOnly: computeFiresOnly(records),
  }

  const sc = selfCheck(records)

  if (opts.json) {
    console.log(JSON.stringify({
      logDir: ARGO_LOG_DIR,
      filesScanned: records.length,
      totalSkippedLines: totalSkipped,
      inventory: inventoryRows.map(r => ({
        ws: r.ws, file: path.basename(r.file), startedAt: r.meta.startedAt ?? null, role: r.role,
        ending: r.ending, cost: r.cost, skipped: r.skipped, taskGraphSteps: r.taskGraphSteps,
      })),
      mechanisms,
      blindSpots: BLIND_SPOTS,
      selfCheck: sc,
    }, null, 2))
    if (!sc.ok) process.exitCode = 1
    return
  }

  console.log(`mechanism-report — ${records.length} file(s) scanned from ${ARGO_LOG_DIR}${totalSkipped ? ` — ${totalSkipped} malformed/unparseable line(s) skipped total` : ''}`)
  renderInventory(inventoryRows, opts.verbose)
  renderMechanisms(mechanisms)
  renderBlindSpots()
  renderSelfCheck(sc)
  if (!sc.ok) process.exitCode = 1
}

main()
