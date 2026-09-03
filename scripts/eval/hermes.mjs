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
 * Remaining known confounds, NOT fixed here (EVAL-PLAN §4.1, PLAN "cross-cutting"):
 *  - Turn budget: Hermes is capped at `--max-turns 60` for a whole task; Argo's
 *    multi-agent path has no total cap and has used 100-104 turns on hard tasks. Until
 *    that is equalised, turns-to-solve is the defensible cost metric, not wall-clock.
 *  - Sampling params: Argo pins temp 0.8 / top_p 0.9 / top_k 40; Hermes sets none.
 *  - Timeout: EVAL_TIMEOUT_S defaults to 1800 here and 900 in e2e.mjs. Setting
 *    EVAL_TIMEOUT_S explicitly equalises BOTH drivers in one variable.
 *  - Isolation: Docker-per-workspace vs `--yolo --ignore-rules` on the host.
 * NEVER interleave Argo and Hermes runs: the unexplained 5-8x per-iteration slowdown
 * (EVAL-PLAN §1.6a) is suspected Ollama model-residency thrash on the shared :11434.
 *
 * Usage: node scripts/eval/hermes.mjs [taskId,taskId,...]
 *   EVAL_TASKS="bigproj-deps,bigproj-effort" node scripts/eval/hermes.mjs
 * Env: EVAL_MAX_TURNS(60) EVAL_TIMEOUT_S(1800) EVAL_RUNS(3) EVAL_JUDGE(1)
 */
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
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

// Same lean host sampling e2e.mjs does (EVAL-PLAN §4.1: Hermes had none, so no
// Argo-vs-Hermes resource comparison was possible at all).
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
        ['chat', '-q', task.prompt, '-m', 'qwen3.6', '--provider', 'ollama-launch', '-Q', '--yolo', '--ignore-rules', '--max-turns', String(MAX_TURNS)],
        { cwd: wsDir, stdio: 'pipe', timeout: TIMEOUT_S * 1000, maxBuffer: 32 * 1024 * 1024 },
      ).toString();
    } catch (e) {
      err = e.message;
      raw = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
    }
    const wallMs = Date.now() - t0;

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
      + ` wall=${Math.round(wallMs / 1000)}s${err ? '  ERR: ' + err.split('\n')[0] : ''}`,
    );
    for (const v of gates.violations) console.log(`      GATE ${v}`);
    for (const w of gates.warnings) console.log(`      note ${w}`);

    const row = {
      ts: new Date().toISOString(), batchId: BATCH_ID, runId, runIndex: i + 1, k: RUNS,
      rubricVersion: RUBRIC_VERSION,
      harness: 'hermes', harnessSha: HARNESS_SHA, model: 'qwen3.6',
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
      cost: { wallMs, iters: null, toolCalls: null, frames: null, genTokens: null, tokPerSec: null, maxCtx: null, compactions: null, evictions: null, peakRssMb: ollamaAtStart.rssMb ?? null, procSplit: ollamaAtStart.procSplit ?? null, sizeStr: ollamaAtStart.sizeStr ?? null, ollamaAtStart },
      // Hermes's interventions are a different mechanism set surfaced in a different
      // format; Argo's friction counters do not apply and are recorded as null rather
      // than as zeros, which would read as "Hermes never fought itself".
      friction: null,
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
console.log(`\n=== Hermes (qwen3.6 via ollama-launch) — ${passTotal}/${nTotal} completed · ${voidedTotal} gate-voided · batch ${batchMean == null ? 'NOT COMPUTABLE' : `${batchMean}/100`} over ${scored.length} scored task(s) · mid-band ${midBand} ===`);
if (midBand === 0) console.log('!! mid-band count is 0 — this batch discriminates nothing (EVAL-PLAN §4.3).');
if (RUNS < 3) console.log(`!! k=${RUNS} < 3 — reliability is not estimable; smoke test only.`);
for (const r of rows) {
  if (!r.completed) console.log(`\n--- ${r.runId} tail ---\n${r.tail}`);
}
