#!/usr/bin/env node
/**
 * Hermes Agent baseline driver — runs the SAME task catalog (tasks.mjs) as e2e.mjs
 * through `hermes chat -q` instead of Argo's HTTP API, against Hermes's own
 * already-configured `ollama-launch` provider / qwen3.6 model (~/.hermes/config.yaml)
 * — same model, same host, same Ollama instance as Argo's own eval, so the
 * comparison is apples-to-apples on the MODEL; the harnesses differ. Previously two
 * separate scripts (eval-suite2-hermes.mjs, eval-bigproj-hermes.mjs) each hand-copied
 * a subset of tasks.mjs's prompts — a real drift risk, now removed by importing.
 *
 * Methodological note: Hermes's `terminal.backend` here is `local` (direct host
 * access to the workspace), not Docker-isolated the way Argo's per-workspace
 * containers are. Acceptable for this scratch fixture comparison, but worth stating
 * plainly rather than presenting the two as isolation-equivalent.
 *
 * BATCH 1 changes: the same two binary gates and the same rubric v2 as e2e.mjs (a
 * baseline scored on a different rubric is not a baseline), k runs per task instead of
 * exactly one, `ollama ps` sampling at each task start, and the same history schema
 * including `agents:false`, the turn budget and the resolved flag set.
 *
 * DELIBERATE differences, kept on purpose (Gabriel's decisions — do NOT equalise these):
 *  - Turn budget: Hermes is capped at `--max-turns 60` for a whole task; Argo's
 *    multi-agent path has no total cap and has used 100-104 turns on hard tasks. Decision:
 *    stay uncapped and report TURNS-TO-SOLVE as the primary cost metric. That metric is now
 *    measurable on both sides — see hermesTurns() below.
 *  - Sampling params: Argo pins temp 0.8 / top_p 0.9 / top_k 40; Hermes sets none.
 *    Decision: keep 0.8, we measure what we ship.
 *  - Isolation: Docker-per-workspace vs `--yolo --ignore-rules` on the host. Irreducible.
 *
 * EQUAL as of BATCH 1b: EVAL_TIMEOUT_S defaults to 1800 in BOTH drivers (it was 1800 here
 * against 900 in e2e.mjs, which handed Hermes twice Argo's wall clock in every default-
 * configuration comparison and recorded a 901s Argo run as a TIMEOUT failure). EVAL_RUNS,
 * EVAL_JUDGE and EVAL_STRICT_EXTRA_TESTS are also read identically by both.
 *
 * REMAINING asymmetries that are NOT deliberate and are NOT fixed here — reported rather
 * than silently patched, because each changes what a score means (see BATCH1b-APPLIED):
 *  - The judge sees a real orchestration ledger for Argo and a "no orchestration log"
 *    placeholder for Hermes. `orchestration_sane` is unscored so that part is harmless, but
 *    `drift_or_hallucination` IS scored (10 of 100) and more material means more chances to
 *    find drift — a systematic tilt against Argo.
 *  - Function-check tasks (`trivial-qa-arithmetic`) match against Hermes's WHOLE transcript
 *    but only Argo's FINAL ANSWER, so Hermes has the easier oracle on those.
 *  - `completed` requires `!err` here, and execFileSync throws on any non-zero exit — so a
 *    Hermes run that does the work and exits non-zero fails, where Argo has no exit code to
 *    fail on.
 * NEVER interleave Argo and Hermes runs: the unexplained 5-8x per-iteration slowdown
 * (EVAL-PLAN §1.6a) is suspected Ollama model-residency thrash on the shared :11434.
 *
 * Usage: node scripts/eval/hermes.mjs [taskId,taskId,...]
 *   EVAL_TASKS="bigproj-deps,bigproj-effort" node scripts/eval/hermes.mjs
 * Env: EVAL_MAX_TURNS(60) EVAL_TIMEOUT_S(1800) EVAL_RUNS(3) EVAL_JUDGE(1)
 */
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  REPO, RUNS_DIR, wsPath, sh, baselineOf, resetWs, shScore,
  rubricScore, qualityScore, appendHistory, RUBRIC_VERSION,
  suiteCmdFor, seededCmdFor, selectTasks, isScored, seededTestFiles,
} from './tasks.mjs';
import {
  runTests, checkIntegrity, checkRegression, seedTargets,
  unrequestedDiffRatio, allowedFilesFor,
} from './gates.mjs';
import { judgeRun } from './quality-judge.mjs';

// ASYMMETRY FIXED (BATCH 1b item 4): the model was hardcoded `qwen3.6` here while e2e.mjs
// reads EVAL_MODELS. Vetting a candidate model with `EVAL_MODELS=<candidate>` therefore ran
// the candidate through Argo and plain qwen3.6 through Hermes, and the resulting comparison
// looked like a harness comparison while actually being a model comparison. Both drivers now
// read the same variable. Only the FIRST entry is used — Hermes runs one model per batch,
// and silently taking entry [0] of a list is better stated than assumed.
const MODELS = (process.env.EVAL_MODELS || 'qwen3.6:latest').split(',').map(s => s.trim()).filter(Boolean);
// Hermes's provider names the model without the `:latest` tag; `ollama list` has exactly one
// qwen3.6 tag, so stripping it keeps the two drivers pointed at the same digest.
const MODEL = (process.env.EVAL_HERMES_MODEL || MODELS[0] || 'qwen3.6').replace(/:latest$/, '');
if (MODELS.length > 1) console.error(`Note: EVAL_MODELS lists ${MODELS.length} models; Hermes runs only the first (${MODEL}).`);
const MAX_TURNS = Number(process.env.EVAL_MAX_TURNS || 60);
const TIMEOUT_S = Number(process.env.EVAL_TIMEOUT_S || 1800);
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS || 3));
const JUDGE_ON = !['0', 'false', 'off', 'no'].includes((process.env.EVAL_JUDGE || '1').trim().toLowerCase());
const STRICT_EXTRA_TESTS = ['1', 'true', 'on', 'yes'].includes((process.env.EVAL_STRICT_EXTRA_TESTS || '').trim().toLowerCase());
const HARNESS_SHA = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, stdio: 'pipe' }).toString().trim(); } catch { return 'nogit'; } })();
const DIFF_OUT_DIR = process.env.EVAL_DIFF_DIR || path.join(RUNS_DIR, 'diffs');

// `EVAL_TASKS` is handled inside selectTasks(); argv[2] is kept for back-compat.
if (!process.env.EVAL_TASKS && process.argv[2]) process.env.EVAL_TASKS = process.argv[2];
const SUITE = selectTasks();
const BATCH_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}_hermes_${HARNESS_SHA}`;

const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
const num = (x, d = 1) => (x == null ? '?' : String(Math.round(x * 10 ** d) / 10 ** d));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ── Turns-to-solve for Hermes (BATCH 1b item 4) ───────────────────────────────────────
// Gabriel's decision makes turns-to-solve the PRIMARY cost metric, and it was not measurable
// on the comparator at all: every cost field on a Hermes row was null, so the designated
// primary metric existed for one of the two harnesses. It turns out Hermes records it
// itself. `~/.hermes/logs/agent.log` emits one line per conversation-loop exit:
//
//   2026-09-03 13:26:31,001 INFO [20260903_132523_ff558f] agent.conversation_loop: \
//     Turn ended: reason=text_response(finish_reason=stop) model=qwen3.6 api_calls=6/60 \
//     budget=6/60 tool_turns=5 last_msg_role=assistant response_len=590 session=<id>
//
// `api_calls=N/60` is Hermes's own count of model calls for that session against its own
// budget — directly comparable with Argo's summed per-frame iterations. Verified against the
// real log: the 2026-09 Hermes eval sessions used 4-21 api_calls (mostly 4-9), against
// Argo's documented 100-104 turns on the hard tasks. So the turn-cost gap is roughly an
// order of magnitude, not the 1.5x the wall-clock comparison suggested.
//
// Attribution is by TIME WINDOW, not session id, because `hermes chat -q` does not print its
// session id. Each run's window is [t0, t0+wallMs] with a few seconds of slack. `api_calls`
// is cumulative within a session, so per session we take the MAX and then sum across
// sessions (normally one per run). Nothing about Hermes is modified to obtain this.
const HERMES_LOG = process.env.HERMES_LOG || path.join(os.homedir(), '.hermes/logs/agent.log');
// Timestamps in agent.log are LOCAL time with no zone, so they are built component-wise
// rather than handed to Date.parse (whose handling of "YYYY-MM-DD HH:MM:SS" is
// implementation-defined). Date.now() is also local-epoch, so the two are comparable.
const HERMES_TURN_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3}) \w+ \[([^\]]*)\][^:]*: Turn ended: (.*)$/;
const HERMES_TOOLERR_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3}) \w+ \[([^\]]*)\][^:]*: Tool (\w+) returned error/;
const logMs = (m) => new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();

function hermesTurns(startMs, endMs, slackMs = 5000) {
  const out = { available: false, turns: null, budget: null, toolTurns: null, sessions: [], toolErrors: null, reasons: [] };
  let text;
  try { text = readFileSync(HERMES_LOG, 'utf8'); } catch { return out; }
  out.available = true;
  const lo = startMs - slackMs, hi = endMs + slackMs;
  const perSession = new Map();
  let toolErrors = 0;
  for (const line of text.split('\n')) {
    const t = HERMES_TURN_RE.exec(line);
    if (t) {
      const ts = logMs(t);
      if (ts < lo || ts > hi) continue;
      const tail = t[9];
      const api = /api_calls=(\d+)\/(\d+)/.exec(tail);
      const tt = /tool_turns=(\d+)/.exec(tail);
      const reason = /reason=(\S+)/.exec(tail);
      const sid = t[8];
      const prev = perSession.get(sid) || { turns: 0, budget: null, toolTurns: 0 };
      // Cumulative within a session — MAX, never a sum, or a session that exits the loop
      // several times is counted several times over.
      if (api) { prev.turns = Math.max(prev.turns, Number(api[1])); prev.budget = Number(api[2]); }
      if (tt) prev.toolTurns = Math.max(prev.toolTurns, Number(tt[1]));
      perSession.set(sid, prev);
      if (reason && !out.reasons.includes(reason[1])) out.reasons.push(reason[1]);
      continue;
    }
    const e = HERMES_TOOLERR_RE.exec(line);
    if (e) { const ts = logMs(e); if (ts >= lo && ts <= hi) toolErrors++; }
  }
  if (perSession.size === 0) return out;   // window matched nothing: turns stay null, not 0
  out.sessions = [...perSession.keys()];
  out.turns = [...perSession.values()].reduce((a, s) => a + s.turns, 0);
  out.toolTurns = [...perSession.values()].reduce((a, s) => a + s.toolTurns, 0);
  out.budget = [...perSession.values()].map(s => s.budget).find(b => b != null) ?? null;
  out.toolErrors = toolErrors;
  return out;
}

// ── PRIMARY cost source: ~/.hermes/state.db, table `sessions` ─────────────────────────
// Hermes records better cost metrics than Argo does, per session, and they are free to read:
//
//   api_call_count      MODEL CALLS — the primary cost metric. Same definition as Argo's
//                       cost.modelCallsTotal (metrics.mjs documents that side exactly).
//   tool_call_count, message_count
//   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
//   model, cwd, started_at, ended_at, end_reason, rewind_count
//
// ATTRIBUTION is by `cwd` (the workspace path) plus a time window. The window is derived
// from the SESSION ID, not from `started_at`: ids are `YYYYMMDD_HHMMSS_<hex>`, which is
// self-describing, whereas `started_at`'s encoding (seconds? ms? text?) is not documented
// and guessing it would be a silent source of mis-attribution. `started_at`/`ended_at` are
// recorded RAW on every row so the encoding becomes known from the first real batch rather
// than assumed now.
//
// SAFETY, non-negotiable — this is Gabriel's live Hermes state:
//   * opened ONLY as `file:<path>?mode=ro`. If the sqlite3 build rejects URI filenames we
//     do NOT retry with a plain path; we fall back to the agent.log reader below, which
//     touches no database at all.
//   * a single SELECT, asserted before it runs. No write, no VACUUM, no pragma, no ATTACH.
//   * zero interpolation: the query takes no parameters. A bounded recent slice is fetched
//     and filtered in JS, so no path or timestamp is ever spliced into SQL.
//   * every failure degrades to null and warns. A missing Hermes metric must never fail a
//     run, and must never be reported as 0 — 0 model calls is a claim, absent is not.
// Note the DB is in WAL mode, so even mode=ro touches `state.db-shm`. That is inherent to
// WAL and is not avoidable without `immutable=1`, which would read stale data by ignoring
// the WAL — unacceptable when the session we want was written seconds ago.
const HERMES_DB = process.env.HERMES_DB || path.join(os.homedir(), '.hermes/state.db');
const SESSION_COLS = ['id', 'cwd', 'started_at', 'ended_at', 'end_reason', 'api_call_count',
  'tool_call_count', 'message_count', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'reasoning_tokens', 'model', 'rewind_count'];
const SESSION_SQL = `SELECT ${SESSION_COLS.join(', ')} FROM sessions ORDER BY rowid DESC LIMIT 300;`;

let dbWarned = false;
function readHermesSessions() {
  if (!existsSync(HERMES_DB)) {
    if (!dbWarned) { console.error(`Note: ${HERMES_DB} not present — falling back to agent.log for turns-to-solve.`); dbWarned = true; }
    return null;
  }
  // Belt-and-braces assertion that what we are about to run is one read-only SELECT.
  if (!/^SELECT [\s\S]*;$/.test(SESSION_SQL) || /;\s*\S/.test(SESSION_SQL.slice(0, -1))) {
    console.error('Refusing to query state.db: SESSION_SQL is not a single SELECT.');
    return null;
  }
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', `file:${HERMES_DB}?mode=ro`, SESSION_SQL],
      { stdio: 'pipe', timeout: 20000, maxBuffer: 16 * 1024 * 1024 }).toString().trim();
    if (!out) return [];
    return JSON.parse(out);
  } catch (e) {
    if (!dbWarned) { console.error(`Note: could not read ${HERMES_DB} read-only (${e.message.split('\n')[0]}) — falling back to agent.log.`); dbWarned = true; }
    return null;
  }
}
// Session ids are `YYYYMMDD_HHMMSS_<hex>`, local time — the same basis as Date.now().
const SESSION_ID_RE = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/;
function sessionIdMs(id) {
  const m = SESSION_ID_RE.exec(String(id || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}
// Tolerant path comparison: a recorded cwd may differ from ours by a symlink prefix
// (/private/var vs /var) or a trailing slash. Which rule matched is recorded, so a loose
// match never passes silently as an exact one.
function cwdMatch(recorded, wsDir) {
  const norm = (p) => String(p || '').replace(/\/+$/, '');
  const a = norm(recorded), b = norm(wsDir);
  if (!a || !b) return null;
  if (a === b) return 'exact';
  if (a.endsWith(b) || b.endsWith(a)) return 'suffix';
  if (a.split('/').pop() === b.split('/').pop()) return 'basename';
  return null;
}

/**
 * Cost for one Hermes run. Prefers state.db (session-keyed, richer); falls back to
 * agent.log's `api_calls=N/M`. When both are available they are cross-checked and any
 * disagreement is recorded rather than resolved silently.
 */
function hermesCost(wsDir, startMs, endMs, slackMs = 15000) {
  const log = hermesTurns(startMs, endMs);
  const rows = readHermesSessions();
  const out = {
    source: 'none', modelCallsTotal: null, toolCalls: null, messages: null,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
    reasoningTokens: null, endReason: null, sessions: [], cwdMatch: null, model: null,
    rewindCount: null, startedAtRaw: null, endedAtRaw: null,
    logTurns: log.turns, logToolTurns: log.toolTurns, logBudget: log.budget,
    logSessions: log.sessions, logReasons: log.reasons, toolErrors: log.toolErrors,
    disagreement: null,
  };
  if (Array.isArray(rows)) {
    const lo = startMs - slackMs, hi = endMs + slackMs;
    const hits = [];
    for (const r of rows) {
      const t = sessionIdMs(r.id);
      if (t == null || t < lo || t > hi) continue;
      const how = cwdMatch(r.cwd, wsDir);
      if (!how) continue;
      hits.push({ r, how });
    }
    if (hits.length) {
      const num = (v) => (v == null ? 0 : Number(v) || 0);
      const sum = (k) => hits.reduce((a, h) => a + num(h.r[k]), 0);
      out.source = 'state.db';
      out.modelCallsTotal = sum('api_call_count');
      out.toolCalls = sum('tool_call_count');
      out.messages = sum('message_count');
      out.inputTokens = sum('input_tokens');
      out.outputTokens = sum('output_tokens');
      // Recorded even though it is 0 in every session observed so far: if NEITHER harness
      // gets prefix-cache reuse that is a shared inefficiency worth surfacing, and a zero
      // that was actually measured is a finding, while a null is only an absence.
      out.cacheReadTokens = sum('cache_read_tokens');
      out.cacheWriteTokens = sum('cache_write_tokens');
      out.reasoningTokens = sum('reasoning_tokens');
      out.endReason = hits.map(h => h.r.end_reason).filter(Boolean).join(',') || null;
      out.model = hits.map(h => h.r.model).filter(Boolean)[0] ?? null;
      out.rewindCount = sum('rewind_count');
      out.sessions = hits.map(h => h.r.id);
      out.cwdMatch = [...new Set(hits.map(h => h.how))].join(',');
      out.startedAtRaw = hits[0].r.started_at ?? null;
      out.endedAtRaw = hits[0].r.ended_at ?? null;
      if (log.turns != null && out.modelCallsTotal !== log.turns) {
        out.disagreement = `state.db api_call_count=${out.modelCallsTotal} vs agent.log api_calls=${log.turns}`;
      }
      return out;
    }
  }
  if (log.turns != null) {
    out.source = 'agent.log';
    out.modelCallsTotal = log.turns;
    out.toolCalls = log.toolTurns;
    out.sessions = log.sessions;
    return out;
  }
  return out;   // source 'none': every field stays null. NEVER 0.
}

// Same lean host sampling e2e.mjs does (EVAL-PLAN §4.1: Hermes had none, so no
// Argo-vs-Hermes resource comparison was possible at all).
//
// NOTE the honest limit, and why `peakRssMb` is NOT populated from this: `execFileSync`
// blocks for the whole run, so there is no opportunity to sample DURING it the way
// e2e.mjs's waitIdle loop does. A single pre-run snapshot is a baseline, not a peak, and
// reporting it as `peakRssMb` would have compared Argo's peak against Hermes's floor and
// systematically flattered Hermes. It is recorded as `rssAtStartMb` and `peakRssMb` stays
// null — an absent measurement, not a misleading one.
function sampleResources() {
  const out = {};
  try {
    const rows = execSync('ollama ps', { stdio: 'pipe' }).toString().trim().split('\n');
    if (rows.length > 1) {
      const cols = rows[1].split(/\s{2,}/);   // NAME  ID  SIZE  PROCESSOR  UNTIL
      if (cols[2]) out.sizeStr = cols[2].trim();
      if (cols[3]) out.procSplit = cols[3].trim();
    }
  } catch { /* ollama not on PATH or nothing loaded */ }
  try {
    const rss = execSync("ps -Ao rss,comm | grep -i ollama | grep -v grep | awk '{s+=$1} END {print s}'", { stdio: 'pipe' }).toString().trim();
    if (rss) out.rssMb = Math.round(Number(rss) / 1024);
  } catch { /* ps unavailable */ }
  return out;
}

// ── PRE-FLIGHT (BATCH 1b item 4) ──────────────────────────────────────────────────────
// e2e.mjs refuses to write a history row when the run never started — that is the fix for
// the four fabricated `ERR` rows of 2026-09-03. This driver had no equivalent: a missing or
// broken `hermes` binary would throw on every task and record a full battery of score-0
// FAIL rows, i.e. exactly the same class of fabricated failure, 42 of them at k=3. Checked
// once, up front, and the batch aborts before any row is written.
try {
  execFileSync('hermes', ['--version'], { stdio: 'pipe', timeout: 30000 });
} catch (e) {
  console.error(`Pre-flight failed: cannot invoke \`hermes --version\` (${e.message.split('\n')[0]}).`);
  console.error('Aborting BEFORE any history row is written — a harness that never ran must not be recorded as a task failure.');
  process.exit(1);
}
if (!existsSync(HERMES_LOG)) {
  // Not fatal: the gates and the score do not depend on it. But turns-to-solve is the
  // designated primary cost metric, so silently recording nulls for it is not acceptable.
  console.error(`Warning: ${HERMES_LOG} not readable — turns-to-solve will be null for every row in this batch.`);
}

const baselines = Object.fromEntries([...new Set(SUITE.map(t => t.ws))].map(ws => [ws, baselineOf(ws)]));
console.log(`Hermes baseline — rubric v${RUBRIC_VERSION} — ${SUITE.length} task(s) × ${RUNS} run(s) · max_turns ${MAX_TURNS} · timeout ${TIMEOUT_S}s · batch ${BATCH_ID}`);
console.log('Do NOT interleave this with an Argo battery (EVAL-PLAN §1.6a).\n');
for (const [ws, base] of Object.entries(baselines)) {
  if (!base) console.error(`!!! ${ws}: no baseline ref — every run in it will be voided by the integrity gate`);
}

const rows = [];
for (const task of SUITE) {
  const wsDir = wsPath(task.ws);
  const suiteCmd = suiteCmdFor(task.ws);
  for (let i = 0; i < RUNS; i++) {
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${task.id}_r${i + 1}`;
    resetWs(task.ws, baselines[task.ws]);
    if (task.setup) sh(task.setup(wsDir), wsDir);

    const ollamaAtStart = sampleResources();
    const baselineSuite = suiteCmd ? runTests(suiteCmd, wsDir) : null;

    const t0 = Date.now();
    let raw = '', err = null;
    try {
      raw = execFileSync(
        'hermes',
        ['chat', '-q', task.prompt, '-m', MODEL, '--provider', 'ollama-launch', '-Q', '--yolo', '--ignore-rules', '--max-turns', String(MAX_TURNS)],
        { cwd: wsDir, stdio: 'pipe', timeout: TIMEOUT_S * 1000, maxBuffer: 32 * 1024 * 1024 },
      ).toString();
    } catch (e) {
      err = e.message;
      raw = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    }
    const wallMs = Date.now() - t0;
    // Turns-to-solve and token cost, from Hermes's own state.db (preferred) or agent.log.
    // Read right after the run, before anything else can append to either.
    const hc = hermesCost(wsDir, t0, t0 + wallMs);
    if (hc.source === 'none') console.error(`      !! no Hermes cost record found for this run — modelCallsTotal is null, NOT 0.`);
    if (hc.disagreement) console.error(`      !! Hermes cost sources disagree: ${hc.disagreement}`);

    // ── GATES (identical to e2e.mjs) ────────────────────────────────────────────────
    const integrity = checkIntegrity({ task, wsDir, baseline: baselines[task.ws], strictExtraTests: STRICT_EXTRA_TESTS });
    const postSuite = suiteCmd ? runTests(suiteCmd, wsDir) : null;
    const regression = checkRegression(baselineSuite, postSuite);
    const declared = seededTestFiles(task).slice().sort();
    let fromSetup = null;
    try { fromSetup = seedTargets(task, wsDir).slice().sort(); } catch (e) { err = err || e.message; }
    const mismatch = fromSetup && JSON.stringify(declared) !== JSON.stringify(fromSetup)
      ? [`integrity-unevaluable: task.testFile ${JSON.stringify(declared)} != setup cp targets ${JSON.stringify(fromSetup)}`] : [];
    const gates = {
      ok: integrity.ok && regression.ok && mismatch.length === 0,
      violations: [...integrity.violations, ...regression.violations, ...mismatch],
      warnings: integrity.warnings,
      checks: { ...integrity.checks, ...regression.checks, suiteCmd, baselineDoNothingPass: baselineSuite ? `${baselineSuite.pass}/${baselineSuite.total}` : null },
    };

    // ── TARGETED CORRECTNESS: seeded test cases only ────────────────────────────────
    const targets = fromSetup || declared;
    const seededCmd = seededCmdFor(targets);
    let targeted = null, targetedFraction = null;
    if (seededCmd) {
      targeted = runTests(seededCmd, wsDir);
      targetedFraction = targeted.fraction;
    } else if (typeof task.check === 'function') {
      // `check` is fed { finalAnswer: raw } so a file-less task can be verified against
      // Hermes's own printed transcript, the same way e2e.mjs uses the run's final answer.
      targetedFraction = task.check({ finalAnswer: raw }) ? 1 : 0;
    }
    const legacyCheck = typeof task.check === 'function' ? task.check({ finalAnswer: raw }) : shScore(task.check, wsDir).exitOk;
    const completed = !err && gates.ok && targetedFraction === 1;

    // ── QUALITY ─────────────────────────────────────────────────────────────────────
    mkdirSync(DIFF_OUT_DIR, { recursive: true });
    let diffText = null, diffPath = null;
    try {
      diffText = sh(`git diff ${baselines[task.ws]}`, wsDir);
      diffPath = path.join(DIFF_OUT_DIR, `${runId}.diff`);
      writeFileSync(diffPath, diffText);
    } catch (e) { console.error(`saveDiff ${runId}: ${e.message}`); }
    const allowed = allowedFilesFor(task);
    const unreq = diffText == null ? null : unrequestedDiffRatio(diffText, { allowFiles: allowed.files, ignoreFiles: targets });
    // Hermes writes no Argo ledger, so the judge sees the diff plus an explicit
    // "no orchestration log" marker (quality-judge.mjs) rather than being skipped.
    const judgment = JUDGE_ON ? await judgeRun({ runId, taskId: task.id, objective: task.prompt, ledgerPath: null, diffText }) : null;
    const quality = qualityScore({ judgment, unrequestedRatio: unreq ? unreq.ratio : null });
    quality.allowFiles = allowed.files; quality.allowFilesSource = allowed.source;
    quality.changedLines = unreq ? unreq.changedLines : null;
    quality.outsideLines = unreq ? unreq.outsideLines : null;
    quality.perFileChangedLines = unreq ? unreq.perFile : null;

    const rubric = rubricScore({ gate: gates, targetedFraction, qualityPoints: quality.points, passRate: null });

    console.log(
      `${completed ? 'DONE' : 'FAIL'}  ${pad(task.id, 26)} r${i + 1}/${RUNS}`
      + ` gate=${gates.ok ? 'ok  ' : 'VOID'} c=${pad(num(rubric.correctness), 4)}/60 q=${pad(num(rubric.quality), 4)}/20`
      // Model calls and input tokens are the headline cost numbers — confound-free, unlike
      // wall clock, which is kept as the trailing aside it now is.
      + ` calls=${pad(hc.modelCallsTotal ?? '?', 3)} tok(in/out)=${pad(hc.inputTokens ?? '?', 7)}/${pad(hc.outputTokens ?? '?', 6)}`
      + ` cache_r=${hc.cacheReadTokens ?? '?'} tools=${pad(hc.toolCalls ?? '?', 3)} src=${pad(hc.source, 9)}`
      + ` wall=${Math.round(wallMs / 1000)}s${err ? '  ERR: ' + err.split('\n')[0] : ''}`,
    );
    for (const v of gates.violations) console.log(`      GATE ${v}`);
    for (const w of gates.warnings) console.log(`      note ${w}`);

    const row = {
      ts: new Date().toISOString(), batchId: BATCH_ID, runId, runIndex: i + 1, k: RUNS,
      rubricVersion: RUBRIC_VERSION,
      harness: 'hermes', harnessSha: HARNESS_SHA, model: MODEL,
      taskId: task.id, ws: task.ws, band: task.band ?? null, scored: isScored(task),
      // Hermes is single-agent by construction here (its own `delegation` subsystem is
      // not invoked by this command line) — recorded explicitly rather than left null,
      // which is what made 17 of the first 33 rows unattributable.
      agents: false,
      maxIterations: MAX_TURNS, timeoutS: TIMEOUT_S,
      effectiveConfig: {
        provider: 'ollama-launch', flags: ['-Q', '--yolo', '--ignore-rules', `--max-turns ${MAX_TURNS}`],
        terminalBackend: 'local', samplingPinned: false,
      },
      completed, legacyCheck,
      score: rubric.total, runScore: rubric.runScore, runScoreMax: rubric.runScoreMax,
      scoreBreakdown: rubric, gates,
      targeted: targeted
        ? { pass: targeted.pass, fail: targeted.fail, total: targeted.total, fraction: targeted.fraction, reporter: targeted.reporter, cmd: targeted.cmd }
        : { pass: null, fail: null, total: null, fraction: targetedFraction, reporter: null, cmd: null },
      quality,
      cost: {
        // ── THE COMPARABLE COST NUMBERS (same field names and definitions as Argo's) ──
        // `modelCallsTotal` here is sessions.api_call_count; on the Argo side it is
        // ollama_request events + chatWithRetry retries + critic calls (metrics.mjs states
        // that definition in full). Hermes has no critic-equivalent, so no aux component.
        modelCallsTotal: hc.modelCallsTotal,
        modelCalls: hc.modelCallsTotal, ollamaRetries: null, auxModelCalls: 0,
        modelCallSource: `hermes: ${hc.source === 'state.db' ? 'sessions.api_call_count' : hc.source === 'agent.log' ? 'agent.log api_calls (state.db unavailable)' : 'NOT MEASURED'}`,
        promptTokensTotal: hc.inputTokens,   // analogue of Argo's summed token_usage.prompt_tokens
        genTokens: hc.outputTokens,
        // Hermes reports cache reuse directly. Observed 0 in every session so far — recorded
        // BECAUSE it is 0: if neither harness gets prefix reuse (Argo's own proxy shows only
        // 2% of calls at near-total reuse) that is a shared inefficiency, not a Hermes quirk.
        cacheReadTokens: hc.cacheReadTokens, cacheWriteTokens: hc.cacheWriteTokens,
        reasoningTokens: hc.reasoningTokens,
        toolCalls: hc.toolCalls, messages: hc.messages,
        // Not available for Hermes: it does not expose a per-call prompt-eval time, so the
        // ms/token proxy Argo uses has no counterpart. Null, not fabricated.
        promptMsPerTokenUpperBound: null, cacheReuse: null,
        iters: hc.modelCallsTotal,   // back-compat alias; same number, same definition
        frames: null, framesWithModelCalls: null, tokPerSec: null, maxCtx: null,
        compactions: null, evictions: null,
        wallMs,
        // peakRssMb stays NULL on purpose — see sampleResources(). A pre-run snapshot is a
        // baseline, not a peak, and labelling it `peakRssMb` would compare Argo's peak with
        // Hermes's floor.
        peakRssMb: null, rssAtStartMb: ollamaAtStart.rssMb ?? null,
        procSplit: ollamaAtStart.procSplit ?? null, sizeStr: ollamaAtStart.sizeStr ?? null, ollamaAtStart,
        // Provenance and cross-check, so no number here is opaque.
        costSource: hc.source, cwdMatch: hc.cwdMatch, hermesSessions: hc.sessions,
        hermesModel: hc.model, endReason: hc.endReason, rewindCount: hc.rewindCount,
        startedAtRaw: hc.startedAtRaw, endedAtRaw: hc.endedAtRaw,
        agentLogTurns: hc.logTurns, agentLogBudget: hc.logBudget, sourceDisagreement: hc.disagreement,
        turnBudget: hc.logBudget, exitReasons: hc.logReasons ?? [],
      },
      // Hermes's interventions are a different mechanism set surfaced in a different
      // format; Argo's friction counters do not apply and are recorded as null rather
      // than as zeros, which would read as "Hermes never fought itself". The one directly
      // comparable number IS available from agent.log: tool calls that returned an error.
      friction: hc.toolErrors == null ? null : { toolErrors: hc.toolErrors },
      frameOutcomes: null,   // Hermes has no frames; null, not an empty tally.
      status: completed ? 'done' : (err ? 'ERR' : 'FAIL'),
      wallMs, err: err ?? null,
      artifacts: { ledger: null, diff: diffPath, judgment: judgment?.outPath ?? null },
      tail: raw.slice(-1200),
    };
    appendHistory(row);
    rows.push(row);
    resetWs(task.ws, baselines[task.ws]);
  }
}

// ── Batch aggregation (same shape as e2e.mjs) ─────────────────────────────────────────
console.log('\n=== per-task scorecard (rubric v2: 60 targeted correctness + 20 quality + 20 reliability) ===');
console.log(pad('task', 26) + pad('band', 8) + pad('n', 3) + pad('pass', 6) + pad('c/60', 7) + pad('q/20', 7) + pad('rel/20', 8) + pad('TOTAL', 7) + 'flags');
const scored = [];
let midBand = 0, voidedTotal = 0, passTotal = 0, nTotal = 0;
for (const task of SUITE) {
  const rs = rows.filter(r => r.taskId === task.id);
  if (!rs.length) continue;
  const passRate = rs.filter(r => r.completed).length / rs.length;
  const cs = rs.map(r => r.scoreBreakdown.correctness).filter(x => x != null);
  const qs = rs.map(r => r.scoreBreakdown.quality).filter(x => x != null);
  const meanC = cs.length === rs.length ? mean(cs) : null;
  const meanQ = qs.length === rs.length ? mean(qs) : null;
  const agg = rubricScore({ gate: { ok: true }, targetedFraction: meanC == null ? null : meanC / 60, qualityPoints: meanQ, passRate });
  const voided = rs.filter(r => !r.scoreBreakdown.gatePassed).length;
  const flags = [];
  if (voided) flags.push(`${voided} VOIDED`);
  if (passRate === 1) flags.push('saturated');
  if (passRate >= 0.4 && passRate <= 0.7) flags.push('MID BAND');
  if (agg.incomplete.length) flags.push(`no total: missing ${agg.incomplete.join('+')}`);
  console.log(
    pad(task.id, 26) + pad(task.band ?? '?', 8) + pad(rs.length, 3) + pad(`${rs.filter(r => r.completed).length}/${rs.length}`, 6)
    + pad(num(meanC), 7) + pad(num(meanQ), 7) + pad(num(agg.reliability), 8)
    + pad(agg.total == null ? '—' : agg.total, 7) + flags.join(', '),
  );
  nTotal += rs.length; passTotal += rs.filter(r => r.completed).length; voidedTotal += voided;
  if (isScored(task)) {
    if (agg.total != null) scored.push(agg.total);
    if (passRate >= 0.4 && passRate <= 0.7) midBand++;
  }
}
const batchMean = scored.length ? Math.round(mean(scored)) : null;
console.log(`\n=== Hermes (${MODEL} via ollama-launch) — ${passTotal}/${nTotal} completed · ${voidedTotal} gate-voided · batch ${batchMean == null ? 'NOT COMPUTABLE' : `${batchMean}/100`} over ${scored.length} scored task(s) · mid-band ${midBand} ===`);

// ── COST SUMMARY (the primary metric) ─────────────────────────────────────────────────
// Printed as its own block, above the wall-clock aside, because model calls and tokens are
// the confound-free numbers: they are unaffected by Docker, host access, --yolo, CPU/GPU
// split or a model reload, all of which corrupt wall-clock comparisons.
const costRows = rows.filter(r => r.cost && r.cost.modelCallsTotal != null);
const unmeasured = rows.length - costRows.length;
console.log('\n=== cost (per task, mean over k) — compare with the Argo scorecard\'s calls/tok columns ===');
console.log(pad('task', 26) + pad('calls', 8) + pad('tok in', 10) + pad('tok out', 9) + pad('cache_r', 9) + pad('tools', 7) + pad('wall', 7) + 'source');
for (const task of SUITE) {
  const rs = costRows.filter(r => r.taskId === task.id);
  if (!rs.length) continue;
  const avg = (f) => { const v = rs.map(r => r.cost[f]).filter(x => x != null); return v.length ? Math.round(mean(v)) : null; };
  console.log(pad(task.id, 26) + pad(avg('modelCallsTotal') ?? '?', 8) + pad(avg('promptTokensTotal') ?? '?', 10)
    + pad(avg('genTokens') ?? '?', 9) + pad(avg('cacheReadTokens') ?? '?', 9) + pad(avg('toolCalls') ?? '?', 7)
    + pad(`${Math.round((avg('wallMs') ?? 0) / 1000)}s`, 7) + [...new Set(rs.map(r => r.cost.costSource))].join(','));
}
const totCalls = costRows.reduce((a, r) => a + (r.cost.modelCallsTotal ?? 0), 0);
const totIn = costRows.reduce((a, r) => a + (r.cost.promptTokensTotal ?? 0), 0);
const totCacheR = costRows.reduce((a, r) => a + (r.cost.cacheReadTokens ?? 0), 0);
console.log(`\nBATCH COST — ${totCalls} model call(s), ${totIn} input token(s), ${totCacheR} cache-read token(s) over ${costRows.length} measured run(s).`);
if (unmeasured) console.log(`!! ${unmeasured} run(s) have NO cost record (modelCallsTotal null, not 0) — check ${HERMES_DB} and ~/.hermes/logs/agent.log.`);
// cache_read_tokens has been 0 in every session observed. Argo's own proxy shows only ~2%
// of its calls achieving near-total prefix reuse. If both hold, prefix caching is being
// wasted by BOTH harnesses and that is a shared, addressable inefficiency.
if (costRows.length && totCacheR === 0) console.log('NOTE cache_read_tokens is 0 across the whole batch — no prefix-cache reuse on the Hermes side at all. Compare cost.cacheReuse on the Argo rows.');
if (rows.some(r => r.cost && r.cost.sourceDisagreement)) {
  console.log('!! state.db and agent.log disagreed on model calls for at least one run:');
  for (const r of rows) if (r.cost?.sourceDisagreement) console.log(`   ${r.runId}: ${r.cost.sourceDisagreement}`);
  process.exitCode = 1;
}
if (midBand === 0) console.log('!! mid-band count is 0 — this batch discriminates nothing (EVAL-PLAN §4.3).');
if (RUNS < 3) console.log(`!! k=${RUNS} < 3 — reliability is not estimable; smoke test only.`);
for (const r of rows) {
  if (!r.completed) console.log(`\n--- ${r.runId} tail ---\n${r.tail}`);
}
