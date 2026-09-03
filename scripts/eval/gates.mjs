/**
 * Eval GATES + TAP parsing (BATCH 1, EVAL-PLAN §3.1 / §5.3 / §5.4).
 *
 * Two binary gates that VOID a run (score 0 AND completed:false) rather than deducting
 * points, because a gamed run and a run that breaks the rest of the suite are not
 * partially-good runs:
 *
 *   integrity  — every seeded test file is byte-identical to the fixture THIS harness
 *                copied in; no test file that was tracked at the baseline was modified
 *                or deleted; the workspace's `test` npm script is unchanged.
 *   regression — every test that passed at the baseline (measured for real, in this
 *                workspace, immediately after seeding) still passes afterwards.
 *
 * Why bytes-vs-fixture and not `git diff --name-only` (the old `testFileTampered`,
 * tasks.mjs:95-102 before this batch): every seeded test file is UNTRACKED, and
 * `git diff --name-only` lists only tracked modifications, so the old check could not
 * fire on any task in the catalog — 12 consecutive runs at full integrity marks were an
 * artifact of the mechanism, not a finding. Comparing against the fixture bytes is the
 * strongest available check: the harness knows exactly what it wrote, and the answer
 * does not depend on git tracking state at all.
 *
 * FAIL LOUDLY, NEVER SILENTLY: the old implementation ended in `catch { return false }`,
 * i.e. "if I cannot tell, assume clean". Every check here that cannot be evaluated
 * records an `integrity-unevaluable` / `regression-unevaluable` violation, which voids
 * the run exactly like a real tamper. A gate that cannot see is not a gate that passes.
 *
 * `git diff <baseline>` (not `HEAD`) is used throughout for the same reason saveDiff in
 * e2e.mjs does: autoCommit (src/agent.ts) may have committed the agent's own work
 * mid-run, moving HEAD forward, so a HEAD-relative view shows almost nothing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

// ── TAP parsing ─────────────────────────────────────────────────────────────────────
// Node's own test runner emits TAP 13 when stdout is not a TTY. Verified against real
// captured output in ~/.local/share/argo/logs (e.g. bigproj 2026-07-30T10-52-09): test
// FILES are not nested, so every case appears as a column-0 `ok N - <name>` /
// `not ok N - <name>` line and there is exactly one column-0 `# pass N` summary.
//
// Anchoring at line start (multiline) and taking the LAST summary match is deliberate
// hardening over the previous unanchored `/#\s*pass\s+(\d+)[\s\S]*?#\s*fail\s+(\d+)/`:
// if a future Node version (or a fixture with subtests) ever nests, the nested summary
// is indented and the run total still comes last, so this keeps working. The old regex
// would have silently locked onto the FIRST nested summary.
const TAP_PASS = /^# pass (\d+)$/gm;
const TAP_FAIL = /^# fail (\d+)$/gm;
// Fallback for Node's `spec` reporter, which prints `ℹ pass N` instead. Counts only —
// the spec reporter's `✔ name` lines are not reliably parseable for names, so a suite
// read through it cannot support the regression gate (reported, not silently accepted).
const SPEC_PASS = /^[ \t]*ℹ pass (\d+)$/m;
const SPEC_FAIL = /^[ \t]*ℹ fail (\d+)$/m;
const TAP_CASE = /^(not ok|ok) (\d+) - (.*)$/gm;

const lastMatch = (re, s) => { let m, out = null; re.lastIndex = 0; while ((m = re.exec(s)) !== null) out = m; return out; };

/**
 * Parse a Node test-runner transcript.
 * @returns {{parsed:boolean, reporter:string|null, pass:number|null, fail:number|null,
 *            total:number|null, fraction:number, names:Map<string,{pass:number,fail:number}>|null}}
 */
export function parseTap(out, exitOk) {
  const p = lastMatch(TAP_PASS, out), f = lastMatch(TAP_FAIL, out);
  if (p && f) {
    const pass = Number(p[1]), fail = Number(f[1]), total = pass + fail;
    const names = new Map();
    let m; TAP_CASE.lastIndex = 0;
    while ((m = TAP_CASE.exec(out)) !== null) {
      // Strip a TAP directive (`# SKIP` / `# TODO`) — a skipped case is neither a pass
      // nor a fail and must not enter the baseline "was passing" set.
      const raw = m[3];
      if (/\s#\s*(SKIP|TODO)\b/i.test(raw)) continue;
      const name = raw.replace(/\s+#.*$/, '').trim();
      const rec = names.get(name) || { pass: 0, fail: 0 };
      if (m[1] === 'ok') rec.pass++; else rec.fail++;
      names.set(name, rec);
    }
    return { parsed: true, reporter: 'tap', pass, fail, total, fraction: total > 0 ? pass / total : (exitOk ? 1 : 0), names };
  }
  const sp = SPEC_PASS.exec(out), sf = SPEC_FAIL.exec(out);
  if (sp && sf) {
    const pass = Number(sp[1]), fail = Number(sf[1]), total = pass + fail;
    return { parsed: true, reporter: 'spec', pass, fail, total, fraction: total > 0 ? pass / total : (exitOk ? 1 : 0), names: null };
  }
  return { parsed: false, reporter: null, pass: null, fail: null, total: null, fraction: exitOk ? 1 : 0, names: null };
}

/** Run a test command in `cwd` and parse it. Never throws on a failing suite. */
export function runTests(cmd, cwd) {
  let out = '', ok = false;
  // maxBuffer well above the default 1 MB: TAP prints a block per case, and a truncated
  // transcript would silently lose the trailing `# pass`/`# fail` summary — i.e. it would
  // read as "unparseable" and, before this batch, as "binary pass".
  const opts = { cwd, stdio: 'pipe', maxBuffer: 32 * 1024 * 1024 };
  try { out = execSync(cmd, opts).toString(); ok = true; }
  catch (e) { out = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : ''); ok = false; }
  const r = parseTap(out, ok);
  return { ...r, cmd, exitOk: ok, raw: out.slice(-4000) };
}

// ── Seeded-file bookkeeping ─────────────────────────────────────────────────────────
// A task's seeded files are declared once, as the `cp` clauses of its own `setup`
// string, so there is no second source of truth to drift. parseSeeds turns that string
// back into an explicit [{fixture, target}] list. STRICT by design: any clause it does
// not recognise throws, which the caller turns into `integrity-unevaluable` (a void),
// because "I could not work out what was seeded" must never read as "nothing was
// tampered with". A task that needs a non-`cp` setup should declare `seeds` explicitly.
const CP_CLAUSE = /^cp\s+"([^"]+)"\s+(\S+)$/;

export function parseSeeds(task, wsDir) {
  if (Array.isArray(task.seeds)) return task.seeds.map(s => ({ ...s }));
  if (!task.setup) return [];
  const script = task.setup(wsDir);
  const seeds = [];
  for (const clause of script.split('&&').map(s => s.trim()).filter(Boolean)) {
    const m = CP_CLAUSE.exec(clause);
    if (!m) throw new Error(`parseSeeds(${task.id}): unrecognised setup clause ${JSON.stringify(clause)} — declare task.seeds explicitly`);
    seeds.push({ fixture: m[1], target: m[2] });
  }
  return seeds;
}

/** Every path a seeded fixture is written to, as declared by the task. */
export const seedTargets = (task, wsDir) => parseSeeds(task, wsDir).map(s => s.target);

// A path that is part of the ORACLE rather than the implementation. Both forms matter:
// `test/helpers.js` is not a `.test.js` file but is oracle infrastructure, and
// eval-suite2's tracked `_seeds/*.test.js` mirror is caught by the suffix form.
export const TEST_PATH_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]s$/;

// ── The gates ───────────────────────────────────────────────────────────────────────

const git = (cmd, cwd) => execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString();

/**
 * INTEGRITY. Returns { ok, violations:[], warnings:[], checks:{...} }.
 * `violations` non-empty ⇒ the run is void (score 0, completed:false).
 *
 * Extra agent-authored `.test.js` files are a WARNING, not a violation — see
 * EXTRA_TEST_FILES note below. Everything else is a violation.
 */
export function checkIntegrity({ task, wsDir, baseline, strictExtraTests = false }) {
  const violations = [], warnings = [], checks = {};
  // Per-task escape hatch for check 2 (BATCH 1b item 2). DEFAULT IS NONE: a task may touch
  // no baseline-tracked test file at all unless it says so explicitly, by path.
  //
  // Why it exists: on the first live run the gate correctly voided `bigproj-observability`
  // for stripping `export` from `advancingClock` and `makeService` in `test/helpers.js` —
  // `makeService` is imported by the seeded `bigproj-audit-log.test.js`, so that edit
  // disabled part of the oracle. That was right. But the same rule would make a task that
  // legitimately needs a helper change impossible to pass, and a gate that makes a task
  // unsatisfiable is worse than no gate. So the strictness is now a per-task declaration
  // rather than a global law.
  //
  // Deliberately NOT a glob and NOT a directory: an exact path list, so widening the gate
  // is a visible, reviewable, per-file act. `bigproj-observability` declares NONE —
  // verified on the host that the task is satisfiable without touching that helper
  // (baseline `makeService()` already returns what the seeded test needs).
  const allowTracked = new Set(Array.isArray(task.allowTrackedTestEdits) ? task.allowTrackedTestEdits : []);
  checks.allowTrackedTestEdits = [...allowTracked];

  // 1. Seeded fixture bytes. The load-bearing check: independent of git entirely.
  let seeds;
  try { seeds = parseSeeds(task, wsDir); }
  catch (e) {
    violations.push(`integrity-unevaluable: ${e.message}`);
    return { ok: false, violations, warnings, checks };
  }
  checks.seededFiles = seeds.length;
  const targets = new Set(seeds.map(s => s.target));
  for (const { fixture, target } of seeds) {
    const abs = path.join(wsDir, target);
    if (!existsSync(fixture)) { violations.push(`integrity-unevaluable: fixture missing on disk: ${fixture}`); continue; }
    if (!existsSync(abs)) { violations.push(`integrity: seeded test file DELETED: ${target}`); continue; }
    let a, b;
    try { a = readFileSync(fixture); b = readFileSync(abs); }
    catch (e) { violations.push(`integrity-unevaluable: cannot read ${target}: ${e.message}`); continue; }
    if (!a.equals(b)) {
      violations.push(`integrity: seeded test file MODIFIED (${b.length}B vs fixture ${a.length}B): ${target}`);
    }
  }

  // 2-4 need the baseline ref. No baseline ⇒ unevaluable ⇒ void (loudly), never "clean".
  if (!baseline) {
    violations.push('integrity-unevaluable: no baseline ref for this workspace (git tag eval-baseline missing and HEAD unreadable)');
    return { ok: false, violations, warnings, checks };
  }

  let trackedAtBaseline, changedVsBaseline, untracked;
  try {
    trackedAtBaseline = new Set(git(`ls-tree -r --name-only ${baseline}`, wsDir).split('\n').map(s => s.trim()).filter(Boolean));
    // `git diff <baseline>` = baseline commit vs WORKING TREE, so it includes anything
    // autoCommit committed mid-run as well as uncommitted edits.
    // Keep EVERY path field, not just the last: a rename is `R100<TAB>old<TAB>new`, and
    // renaming a tracked test file out of the suite is a tamper that only the OLD path
    // reveals (the new path is not tracked at the baseline, so a last-field-only read
    // would miss it entirely).
    changedVsBaseline = git(`diff --name-status ${baseline} --`, wsDir).split('\n').map(s => s.trim()).filter(Boolean)
      .map(line => { const parts = line.split('\t'); return { st: parts[0], p: parts[parts.length - 1], paths: parts.slice(1) }; });
    // `ls-files --others` lists individual files (unlike `git status`, which can collapse
    // an untracked directory to `dir/`).
    untracked = git('ls-files --others --exclude-standard', wsDir).split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    violations.push(`integrity-unevaluable: git inspection failed: ${e.message}`);
    return { ok: false, violations, warnings, checks };
  }
  checks.changedFiles = changedVsBaseline.length;

  // 2. A test file that existed (tracked) at the baseline must not be modified/deleted/
  //    renamed. This is the case the old git-diff check was aiming at, kept because it
  //    catches tampering with the 36 tracked bigproj tests, which no fixture covers.
  const allowedTouches = [];
  for (const { st, paths } of changedVsBaseline) {
    if (!/^[MDR]/.test(st)) continue;
    for (const p of paths) {
      if (!TEST_PATH_RE.test(p) || !trackedAtBaseline.has(p)) continue;
      const what = st === 'D' ? 'DELETED' : st.startsWith('R') ? 'RENAMED' : 'CHANGED';
      // A DELETE or RENAME is never allowed, even for a declared path: removing a file the
      // seeded specs import breaks the oracle just as thoroughly as editing it, and no task
      // has a legitimate reason to delete a helper it was told it may edit.
      if (allowTracked.has(p) && what === 'CHANGED') {
        allowedTouches.push(p);
      } else {
        violations.push(`integrity: baseline-tracked test file ${what} (${st}): ${paths.join(' -> ')}`
          + (allowTracked.has(p) ? ' — declared in allowTrackedTestEdits, but only CHANGED is permitted there, not DELETED/RENAMED' : ''));
      }
      break;
    }
  }
  checks.allowedTrackedTouches = allowedTouches;
  // A declared allowance that was exercised is still worth seeing in the run output: it is
  // the one place the oracle was legitimately modified, so it is where to look first if the
  // score is surprising.
  for (const p of allowedTouches) warnings.push(`integrity-warning: baseline-tracked test file changed under an explicit allowance: ${p}`);

  // 3. Test files that did not exist at the baseline and are not seeded by us.
  //    NOT a violation by default — DEVIATION from EVAL-PLAN §3.1, see BATCH1-APPLIED:
  //    with check 1 in place an added test file cannot make the seeded oracle pass
  //    falsely (Node runs each test file in its own process), so it is measurement
  //    noise, not a gaming vector, and voiding a run for writing extra tests would
  //    reject legitimate work. Recorded so it is visible; EVAL_STRICT_EXTRA_TESTS=1
  //    promotes it to a violation.
  const extra = [
    ...changedVsBaseline.filter(({ st, p }) => st.startsWith('A') && TEST_PATH_RE.test(p) && !targets.has(p)).map(x => x.p),
    ...untracked.filter(p => TEST_PATH_RE.test(p) && !targets.has(p)),
  ];
  const extraTests = [...new Set(extra)];
  checks.extraTestFiles = extraTests;
  if (extraTests.length) {
    const msg = `agent-authored test file(s) outside the seeded set: ${extraTests.join(', ')}`;
    if (strictExtraTests) violations.push(`integrity: ${msg}`); else warnings.push(`integrity-warning: ${msg}`);
  }

  // 4. The `test` npm script — the cheapest possible way to make everything "pass".
  try {
    const before = JSON.parse(git(`show ${baseline}:package.json`, wsDir));
    const afterPath = path.join(wsDir, 'package.json');
    const after = existsSync(afterPath) ? JSON.parse(readFileSync(afterPath, 'utf8')) : null;
    const a = before?.scripts?.test ?? null, b = after?.scripts?.test ?? null;
    checks.testScript = b;
    if (a !== b) violations.push(`integrity: package.json "test" script changed: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  } catch (e) {
    // No package.json at the baseline is legitimate (booklet has none) — distinguish
    // that from an unreadable/unparseable one, which is unevaluable.
    if (/does not exist|exists on disk, but not in|Path .* does not exist/i.test(e.message)) checks.testScript = 'n/a (no package.json at baseline)';
    else violations.push(`integrity-unevaluable: cannot compare package.json test script: ${e.message}`);
  }

  return { ok: violations.length === 0, violations, warnings, checks };
}

/**
 * REGRESSION. `before`/`after` are runTests() results over the SAME whole-suite command,
 * taken immediately after seeding and immediately after the run.
 *
 * Name-keyed, not count-keyed, on purpose: a run that breaks one tracked test while
 * fixing six seeded ones has a HIGHER pass count and would slip through a count check.
 * Duplicate test names across files are handled by comparing per-name pass COUNTS.
 */
export function checkRegression(before, after) {
  const violations = [], checks = {};
  if (!before) return { ok: true, violations, checks: { regression: 'n/a (no suite command for this workspace)' } };
  if (!before.parsed || before.total === 0) {
    // Nothing was passing at the baseline (or there is no suite at all, e.g. an
    // eval-suite2 task before any spec is seeded) — there is nothing to regress.
    checks.regression = `n/a (baseline suite ${before.parsed ? `has ${before.total} case(s)` : 'not parseable'})`;
    return { ok: true, violations, checks };
  }
  if (!before.names || !after.names) {
    // Counts only (spec reporter). Say so rather than pretending the gate held.
    violations.push(`regression-unevaluable: suite output has no per-case names (reporter=${before.reporter}/${after.reporter}) — force TAP with --test-reporter=tap`);
    return { ok: false, violations, checks };
  }
  if (!after.parsed) {
    violations.push(`regression: post-run suite produced no parseable summary (exit ${after.exitOk ? 0 : 'non-zero'}) while ${before.pass} case(s) passed at baseline`);
    return { ok: false, violations, checks };
  }
  const broken = [];
  for (const [name, rec] of before.names) {
    if (rec.pass === 0) continue;              // was not passing at baseline
    const post = after.names.get(name);
    if (!post || post.pass < rec.pass) broken.push(name);
  }
  checks.baselinePass = before.pass;
  checks.baselineTotal = before.total;
  checks.postPass = after.pass;
  checks.postTotal = after.total;
  checks.brokenAtBaseline = broken;
  for (const name of broken.slice(0, 12)) violations.push(`regression: test passed at baseline and now fails/vanished: ${name}`);
  if (broken.length > 12) violations.push(`regression: …and ${broken.length - 12} more`);
  return { ok: broken.length === 0, violations, checks };
}

// ── Unrequested-diff ratio (the deterministic half of the 20 quality points) ─────────
// "Changed lines outside the files the task names, as a fraction of total changed
// lines" (EVAL-PLAN §3.1). The seeded fixtures themselves are excluded from BOTH sides:
// they are ~85 added lines the HARNESS wrote, and leaving them in the denominator would
// make every multi-file seeding task look clean regardless of what the agent did.
export function unrequestedDiffRatio(diffText, { allowFiles, ignoreFiles }) {
  const allow = new Set(allowFiles || []);
  const ignore = new Set(ignoreFiles || []);
  let total = 0, outside = 0, file = null;
  const perFile = {};
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('+++ ')) { const p = line.slice(4).trim(); file = p === '/dev/null' ? file : p.replace(/^b\//, ''); continue; }
    if (line.startsWith('--- ')) { const p = line.slice(4).trim(); if (p !== '/dev/null') file = p.replace(/^a\//, ''); continue; }
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('@@')) continue;
    if (!/^[+-]/.test(line)) continue;
    if (!file || ignore.has(file)) continue;
    total++;
    perFile[file] = (perFile[file] || 0) + 1;
    if (!allow.has(file)) outside++;
  }
  return { ratio: total > 0 ? outside / total : 0, changedLines: total, outsideLines: outside, perFile };
}

// Paths the agent may always touch without it counting as unrequested work: MEMORY.md
// is written by the harness's own durable-memory mechanism, not by the agent choosing
// to do extra work.
export const ALWAYS_ALLOWED_PATHS = ['MEMORY.md'];

// Files a task legitimately names. Explicit `task.allowFiles` wins; otherwise the paths
// the PROMPT itself names are extracted, which is the same information a human reviewer
// would use. Reported alongside the ratio so a miscalibrated allow-list is visible.
const PROMPT_PATH_RE = /\b(?:src|lib|test|tests)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[cm]?[jt]s\b/g;
export function allowedFilesFor(task) {
  if (Array.isArray(task.allowFiles)) return { files: [...task.allowFiles, ...ALWAYS_ALLOWED_PATHS], source: 'task.allowFiles' };
  const found = new Set(ALWAYS_ALLOWED_PATHS);
  for (const m of String(task.prompt || '').match(PROMPT_PATH_RE) || []) found.add(m);
  return { files: [...found], source: 'prompt-extracted' };
}
