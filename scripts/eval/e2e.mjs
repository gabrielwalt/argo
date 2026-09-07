#!/usr/bin/env node
/**
 * Argo END-TO-END eval — runs REAL Argo agent loops and scores whether the model
 * actually COMPLETED the task (a check command exits 0), plus quality AND cost
 * metrics from the run log and the host: turns, tool calls, plan, harness
 * interventions, peak context, compactions, wall-clock, generation throughput,
 * peak memory, and CPU/GPU split. This is the slow, truthful layer that
 * complements the fast single-turn probe in probe.mjs — where "can a small model
 * do a hard, long task without drifting, and at what cost" is actually measured.
 *
 * Tasks (tasks.mjs) are made NON-TRIVIAL and self-verifying via a `setup` step that
 * seeds a FAILING test. Completion = the agent implemented it so the whole suite passes.
 *
 * Per model × task × run: reset workspace to baseline → run task.setup → POST
 * /ws/<name>/reset → POST /ws/<name>/chat → poll /ws/<name>/status until idle
 * (sampling host resources meanwhile) → run task.check → read newest run log for
 * metrics → reset. Prints a per-model scorecard, stamped with the harness git SHA,
 * plus a ready-to-paste docs/eval-log.md block.
 *
 * ⚠️ DESTRUCTIVE: between runs it does `git reset --hard <baseline> && git clean -fdx`
 * in each workspace. Only run on repos whose current HEAD is the baseline you want.
 * Runs on the HOST (Argo running with workspaces ATTACHED, Ollama reachable, password known).
 *
 * Usage:
 *   ARGO_PASSWORD=... npm run eval:e2e
 *   ARGO_PASSWORD=... EVAL_MODELS="qwen3.6:latest,<candidate>" EVAL_RUNS=2 npm run eval:e2e
 * Env: ARGO_URL(http://localhost:3000) ARGO_PASSWORD(req) ARGO_LOGS_DIR(~/.local/share/argo/logs)
 *   ARGO_WS_ROOT(~/Sources/test) EVAL_MODELS EVAL_RUNS(3) EVAL_MAX_ITER(60) EVAL_TIMEOUT_S(1800)
 *
 * EVAL_TIMEOUT_S defaults to 1800 here and in hermes.mjs — the SAME value, deliberately.
 * It was 900 vs 1800, which handed Hermes twice Argo's wall clock in every default-
 * configuration comparison, and it cut a real run off at 901s of a 900s budget and recorded
 * it as TIMEOUT — an agent failure that was a measurement artefact. This is the timeout
 * governing how long the eval WAITS for the worker to go idle; on expiry it also POSTs
 * /stop, so it is a real cutoff, not just a polling limit.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  TASKS, REPO, WS_ROOT, RUNS_DIR, wsPath, sh, shOk, baselineOf, resetWs,
  shScore, rubricScore, qualityScore, appendHistory, RUBRIC_VERSION,
  suiteCmdFor, seededCmdFor, selectTasks, isScored, seededTestFiles,
  typesCheckFor, runsOn, turnsOf, isMultiTurn,
} from './tasks.mjs';
import {
  runTests, checkIntegrity, checkRegression, seedTargets,
  unrequestedDiffRatio, allowedFilesFor,
} from './gates.mjs';
import { runMetrics, listJsonlFiles, selfCheckCounters, frameOutcomes } from './metrics.mjs';
import { judgeRun } from './quality-judge.mjs';

const URL_BASE = process.env.ARGO_URL || 'http://localhost:3000';
const PASSWORD = process.env.ARGO_PASSWORD;
// Default target model is qwen3.6 (the validated agentic model). Pass EVAL_MODELS to
// vet a candidate (a newer qwen, or any new local model) against the same tasks.
const MODELS = (process.env.EVAL_MODELS || 'qwen3.6:latest').split(',').map(s => s.trim()).filter(Boolean);
// k=3 by default (BATCH 1 item 6 / EVAL-PLAN §4.3). At k=1 a task that passes cannot be
// distinguished from one that passes 60% of the time — which is exactly the band a
// discriminating item must occupy — and the project's own data shows the variance is
// large (bigproj-effort: 23-174 iterations, 177-1616 s on identical code). The rubric's
// reliability term is defined over these k runs, so k=1 now yields NO composite score
// at all rather than a number that looks comparable and is not.
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS || 3));
// Judge inline (EVAL-PLAN §3.1 puts 20 of the 100 points behind quality-judge.mjs, so it
// can no longer be a separate optional pass). EVAL_JUDGE=0 skips it; the rubric then
// reports quality:null and refuses to produce a composite total, which is the correct
// outcome rather than a silently-reweighted score.
const JUDGE_ON = !['0', 'false', 'off', 'no'].includes((process.env.EVAL_JUDGE || '1').trim().toLowerCase());
const STRICT_EXTRA_TESTS = ['1', 'true', 'on', 'yes'].includes((process.env.EVAL_STRICT_EXTRA_TESTS || '').trim().toLowerCase());
const MAX_ITER = Number(process.env.EVAL_MAX_ITER || 60);
// 1800 to MATCH hermes.mjs's default. It was 900 here against Hermes's 1800, so every
// default-configuration comparison silently gave Hermes twice the wall clock — and a
// bigproj-observability run was cut off at 901s of a 900s budget, recorded as TIMEOUT,
// which looked like an agent failure and was a measurement artefact. Equal budgets are a
// precondition for the comparison meaning anything; see docs/research/07-evaluation-methodology.md.
const TIMEOUT_S = Number(process.env.EVAL_TIMEOUT_S || 1800);
const LOGS_DIR = process.env.ARGO_LOGS_DIR || path.join(os.homedir(), '.local/share/argo/logs');
// Multi-agent's per-workspace ledger (.argo/ledger.jsonl — delegation/conclusion/
// standup/injection entries, the authoritative record of WHICH frames ran and what
// verdicts the Boss returned) lives INSIDE the workspace and is gitignored, so the
// very next resetWs() (`git clean -fdx`) deletes it before it can be inspected. Saved
// out here, per task/run, so a later qualitative pass over orchestration behavior
// (which frames spawned, in what order, what the Boss decided) has something to
// read — the JSONL logs alone can't answer "did the Boss escalate," only the ledger
// records that.
//
// BATCH 1: keyed by runId, not taskId. At the new k=3 default, three runs of the same
// task previously overwrote each other's ledger, diff and judgment, so two thirds of the
// artifacts for every task were destroyed as they were produced — and the surviving one
// was silently attributed to "the" run. runId is recorded on the history row.
const LEDGER_OUT_DIR = process.env.EVAL_LEDGER_DIR || path.join(RUNS_DIR, 'ledgers');
function saveLedger(ws, runId) {
  const src = path.join(wsPath(ws), '.argo', 'ledger.jsonl');
  if (!existsSync(src)) return null;
  mkdirSync(LEDGER_OUT_DIR, { recursive: true });
  const dest = path.join(LEDGER_OUT_DIR, `${runId}.jsonl`);
  try { copyFileSync(src, dest); return dest; } catch { return null; }
}
// Same problem as the ledger above, for the actual CODE change: resetWs()'s `git
// reset --hard` wipes it before a later quality-judge pass (scripts/eval/quality-
// judge.mjs) could read it. Saved as a plain unified diff, not committed anywhere.
const DIFF_OUT_DIR = process.env.EVAL_DIFF_DIR || path.join(RUNS_DIR, 'diffs');
// Diffs against the task's own BASELINE ref (the same one resetWs() restores to), NOT
// bare `HEAD` — autoCommit() (src/agent.ts) may have committed the agent's own work
// during the run, moving HEAD forward to include it, which would make `git diff HEAD`
// show almost nothing (a real bug hit once: it made a complete, test-passing
// implementation look like it had "only added an unrelated remove() method" to the
// quality judge, which correctly flagged drift/hallucination given that bad input —
// the judge wasn't wrong, the diff it was fed was).
function saveDiff(ws, runId, baseline) {
  mkdirSync(DIFF_OUT_DIR, { recursive: true });
  const dest = path.join(DIFF_OUT_DIR, `${runId}.diff`);
  try {
    const diff = sh(`git diff ${baseline}`, wsPath(ws));
    writeFileSync(dest, diff);
    return { path: dest, text: diff };
  } catch (e) {
    // An unreadable diff is not "no unrequested changes" — it is an unknown, so the
    // quality term is left null rather than being awarded full marks by default.
    console.error(`saveDiff ${runId}: ${e.message}`);
    return { path: null, text: null };
  }
}
const OPTS = { temperature: 0.8, top_p: 0.9, top_k: 40, num_ctx: 65536 };
const HARNESS_SHA = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim(); } catch { return 'nogit'; } })();
const DIRTY = (() => { try { return execSync('git status --porcelain', { cwd: REPO }).toString().trim().length > 0 ? '+dirty' : ''; } catch { return ''; } })();

if (!PASSWORD) { console.error('Set ARGO_PASSWORD (Argo sign-in password).'); process.exit(1); }

const authHeaders = { 'content-type': 'application/json', 'x-argo-password': PASSWORD };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Host resource snapshot (lean, cross-platform-ish): model VRAM footprint + CPU/GPU
// split from `ollama ps`, and resident memory of the Ollama process(es) via `ps`.
// True GPU-utilisation % on Apple Silicon needs `powermetrics`/sudo — deliberately
// out of scope; tokens/sec (from the run log) + this split are the lean proxy.
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

async function waitIdle(ws) {
  const t0 = Date.now();
  let peakRssMb = 0, procSplit = '', sizeStr = '';
  await sleep(1500);
  while (Date.now() - t0 < TIMEOUT_S * 1000) {
    let busy = null;
    try { busy = (await (await fetch(`${URL_BASE}/ws/${ws}/status`, { headers: authHeaders })).json()).busy; } catch { /* transient */ }
    const r = sampleResources();
    if (r.rssMb && r.rssMb > peakRssMb) peakRssMb = r.rssMb;
    if (r.procSplit) procSplit = r.procSplit;
    if (r.sizeStr) sizeStr = r.sizeStr;
    if (busy === false) return { idle: true, peakRssMb, procSplit, sizeStr };
    await sleep(3000);
  }
  return { idle: false, peakRssMb, procSplit, sizeStr };
}

// Scrape per-run quality + cost from ALL JSONL logs touched during this run, not just
// "the newest file" — the multi-agent dispatch loop (src/dispatch.ts, the only
// execution path now) means ONE /chat call produces MULTIPLE log files: the dispatch's
// own top-level narrative (start/objective/message/done) PLUS one separate file per
// spawned frame (Planner/Implementer/Boss each get their own real Agent.chat() log).
// Taking only the alphabetically-last file silently picked up whichever frame happened
// to write last (often a short Boss check, e.g. "it=2") and completely missed the real
// Implementer/Planner work — a baseline-era assumption ("one /chat call, one log file")
// that no longer holds.
//
// Selection is by SNAPSHOT DIFF (listJsonlFiles before/after), not an mtime window —
// an mtime window with a negative clock-skew buffer was tried first and is provably
// wrong: a frame from the PREVIOUS task can still be mid-flush (SessionLogger's async
// write queue) at the exact moment THIS task's `POST /chat` fires, so its file's mtime
// lands inside the current task's "window" even though the file itself already existed
// (and was created) before this task started. Confirmed on a real run: `quixbugs-kth`
// reported frames=6 from an mtime-window read, but only 4 files actually belonged to
// it — the other 2 were the tail-end flush of the immediately-preceding task. A
// snapshot of filenames-that-already-exist, diffed against filenames-after, is immune
// to this because it keys on file EXISTENCE (assigned once, at frame creation), not a
// timestamp that can be bumped by an unrelated late write.
//
// The scraping itself now lives in metrics.mjs. BATCH 1 replaced the three inline
// prose-grep counters (`gate`, `reground`, `steer`) that used to sit here: two of the
// three were dead. `gate` matched a `warning` message that commit e045d0a moved to
// `tool_result.error` (49 firings in July, 24 in September, all invisible), and `steer`
// matched only pre-ARGO_LOOP wording so it has been blind since 2026-08-04 while the loop
// ladder fired 158 L0 / 24 L1 / 13 L2. Every `g=0 s=0` in history.jsonl is an artifact.
// metrics.mjs anchors each pattern to a named construction site in src/, self-checks them
// against known samples at start-up, and counts every unmatched warning so a future
// wording change surfaces as data rather than as a zero.
//   frames   — how many separate Agent.chat() logs this run produced: 1 for the Boss
//              task-start checkpoint alone (an ANSWER), or more whenever it spawned a
//              Planner/Implementer frame
//   tok/s    — generation throughput; needs the harness to log Ollama eval_duration
//              (token_usage.eval_duration_ms). "?" until that lands — see roadmap Phase 3(b).

const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
const secs = (ms) => ms != null ? `${Math.round(ms / 1000)}s` : '?';
const num = (x, d = 1) => (x == null ? '?' : String(Math.round(x * 10 ** d) / 10 ** d));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Counter self-check (metrics.mjs). Printed LOUDLY and stamped on every row, because the
// defect being fixed here is precisely a counter that stopped matching and reported zero
// for two months without anyone noticing. Non-fatal — a broken counter must not abort a
// battery — but it sets a non-zero exit code so CI/scripts see it.
const counterCheck = selfCheckCounters();
if (!counterCheck.ok) {
  console.error('!!! INTERVENTION COUNTER SELF-CHECK FAILED — friction numbers in this batch are NOT trustworthy:');
  for (const f of counterCheck.failures) console.error(`    ${f}`);
  console.error('    Fix metrics.mjs against the current src/ wording before believing any friction column.\n');
  process.exitCode = 1;
}

const SUITE = selectTasks().filter(t => runsOn(t, 'argo'));
// ── compactThreshold as a DECLARED, RECORDED dimension of a batch ──────────────────────
// Hermes compresses at 50% of its context window; Argo compacts at ~94%
// (compactThreshold = (65536 - compactReserveTokens)/65536 = 0.9375 with the default 4096
// reserve). If qwen degrades with context length — which Gabriel's manual testing and the
// Context Rot report both indicate — then Hermes never enters the degraded regime and Argo
// lives there. That is a config change to test, not a build.
//
// This eval does NOT change the default: the threshold is a worker-side config value and the
// /chat body cannot override it. What it does is (a) read the RESOLVED value from
// /ws/<ws>/status per run and record it, so rows from batteries at different thresholds are
// distinguishable rather than silently pooled, and (b) accept
// EVAL_EXPECT_COMPACT_THRESHOLD so a battery intended to run at ~50% fails loudly if the
// worker was not actually reconfigured. Getting the number wrong silently is the only way
// this experiment can waste a night.
const EXPECT_COMPACT_THRESHOLD = process.env.EVAL_EXPECT_COMPACT_THRESHOLD
  ? Number(process.env.EVAL_EXPECT_COMPACT_THRESHOLD) : null;
const BATCH_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}_argo_${HARNESS_SHA}${DIRTY}`;
const retiredCount = TASKS.length - TASKS.filter(t => !t.retired).length;

console.log(`Argo E2E eval — harness ${HARNESS_SHA}${DIRTY} — rubric v${RUBRIC_VERSION} — ${MODELS.length} model(s) × ${SUITE.length} task(s) × ${RUNS} run(s) — ${URL_BASE}`);
console.log(`batch ${BATCH_ID} · catalog ${TASKS.length} (${retiredCount} retired, ${SUITE.filter(t => !isScored(t)).length} unscored floor probe(s) in this run) · counters ${counterCheck.ok ? 'self-check OK' : 'SELF-CHECK FAILED'}\n`);

const baselines = Object.fromEntries([...new Set(SUITE.map(t => t.ws))].map(ws => [ws, baselineOf(ws)]));
for (const [ws, base] of Object.entries(baselines)) {
  if (!base) console.error(`!!! ${ws}: no baseline ref (tag it: git -C ${wsPath(ws)} tag -f eval-baseline) — every run in it will be voided by the integrity gate`);
}
// Every row this batch wrote, for the end-of-batch reliability aggregation. The rubric's
// reliability term is defined over the k runs in THIS batch, so it can only be computed
// here — never per run. See rubricScore().
const rows = [];

for (const model of MODELS) {
  for (const task of SUITE) {
    const wsDir = wsPath(task.ws);
    const suiteCmd = suiteCmdFor(task.ws);
    for (let i = 0; i < RUNS; i++) {
      const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${task.id}_r${i + 1}`;
      resetWs(task.ws, baselines[task.ws]);
      let completed = false, m = {}, rubric = null, started = false;
      let gates = { ok: false, violations: ['gate-not-evaluated'], warnings: [], checks: {} };
      let targeted = null, targetedFraction = null, legacyCheck = null, quality = null;
      let effective = null, ledgerPath = null, diffInfo = { path: null, text: null }, judgment = null;
      let ollamaAtStart = null, err = null, frames = null;
      // Multi-turn bookkeeping. `perTurn` is per-prompt cost/context, which is what makes a
      // cross-turn memory claim checkable: if the agent retained turn 1's localisation, turn 2
      // should be cheaper than turn 1, not more expensive. Resource peaks are folded across
      // turns because waitIdle samples per turn.
      const perTurn = [];
      let peakRss = 0, lastProcSplit = '', lastSizeStr = '';
      let typesCmd = null, typesBaselineOk = null, typesAfter = null;
      const turns = turnsOf(task);
      try {
        // Turn 1's fixtures are seeded BEFORE the baseline suite is measured, so the
        // do-nothing baseline includes them. Later turns seed just before their own prompt —
        // a multi-turn task's turn-N spec must not exist while turn N-1 is being worked on,
        // or the agent can see and satisfy work it was not yet asked for.
        if (turns[0].setup) sh(turns[0].setup(wsDir), wsDir);

        // PRE-FLIGHT (EVAL-PLAN §4.3). Assert the worker is reachable and IDLE, and
        // capture the RESOLVED effective config (agents/tasks/memory/loop/grounding/
        // model) from the worker itself rather than assuming what the env file says.
        // On failure this throws BEFORE `started`, and no history row is written — which
        // is the fix for the four fabricated `ERR` rows at 11:35:25 on 2026-09-03: a
        // `POST /reset → 409` (worker busy after a detach/reattach) was recorded as four
        // real task failures at score 0, and trend.mjs has reported bigproj-deps as
        // 0/1 pass with mean score 0 ever since.
        const st = await get(task.ws, 'status');
        if (st.busy !== false) throw new Error(`preflight: /ws/${task.ws}/status reports busy=${JSON.stringify(st.busy)} — refusing to start (no row recorded)`);
        effective = {
          model: st.model ?? null, agents: st.agents ?? null, tasks: st.tasks ?? null,
          memory: st.memory ?? null, loop: st.loop ?? null, grounding: st.grounding ?? null,
          autoCommit: st.autoCommit ?? null, compactReserveTokens: st.compactReserveTokens ?? null,
          // Dispatch-path flags, PROCESS-level (not per-run /chat overridable). Recorded so an
          // arm is attributable from the worker itself, never from ~/.config/argo/env.
          schemaControlPlane: st.schemaControlPlane ?? null, verbatimRequest: st.verbatimRequest ?? null,
          // The context-management dimension, recorded per run (see EXPECT_COMPACT_THRESHOLD).
          // /status computes this as (65536 - compactReserveTokens)/65536 and it is the number
          // to compare against Hermes's 0.5.
          compactThreshold: st.compactThreshold ?? null,
          workspacePath: st.workspacePath ?? null,
        };
        if (EXPECT_COMPACT_THRESHOLD != null && st.compactThreshold != null
            && Math.abs(st.compactThreshold - EXPECT_COMPACT_THRESHOLD) > 0.01) {
          throw new Error(`preflight: compactThreshold is ${st.compactThreshold} but EVAL_EXPECT_COMPACT_THRESHOLD=${EXPECT_COMPACT_THRESHOLD}`
            + ' — the worker was not reconfigured for this condition, so the battery would be mislabelled. Refusing to start (no row recorded).');
        }
        ollamaAtStart = sampleResources();

        // BASELINE SUITE for the regression gate — measured for real, in this workspace,
        // AFTER seeding and BEFORE the agent runs. This is also the "do-nothing" score
        // EVAL-PLAN §3.4 step 2 says nobody ever checked, which is why the 71-81 floor on
        // bigproj went unnoticed for a month.
        const baselineSuite = suiteCmd ? runTests(suiteCmd, wsDir) : null;
        // TYPE CHECK, baseline-calibrated exactly like the regression gate: run it before the
        // agent, and enforce it afterwards ONLY if it passed here. commander's `npm test` is
        // `node --test && npm run check:type:ts`, so the type check is genuinely part of "the
        // tests pass" for that repo — but if the toolchain is not invocable on this host, a
        // task that asks for typings changes must not become impossible.
        typesCmd = typesCheckFor(task.ws);
        typesBaselineOk = typesCmd ? shScore(typesCmd, wsDir).exitOk : null;

        // POST /reset ONCE, before the first turn only. For a multi-turn task (H25) the
        // whole point is that turns 2..n share the agent's session — resetting between them
        // would clear the history and turn a cross-turn memory test into three independent
        // one-shot runs. This single line is the difference between the two.
        await post(task.ws, 'reset', {});
        const tRun = Date.now();
        const filesBefore = listJsonlFiles(LOGS_DIR, task.ws);
        const HARNESS = ['1', 'true', 'on', 'yes'].includes((process.env.EVAL_HARNESS || '').trim().toLowerCase());
        let idleAll = true;
        for (let ti = 0; ti < turns.length; ti++) {
          const turn = turns[ti];
          // Turn 1 was seeded before the baseline measurement; seed each later turn now, so
          // its spec does not exist while the previous turn is being worked on.
          if (ti > 0 && turn.setup) sh(turn.setup(wsDir), wsDir);
          const tTurn = Date.now();
          const beforeTurn = listJsonlFiles(LOGS_DIR, task.ws);
          await post(task.ws, 'chat', { message: turn.prompt, model, options: OPTS, maxIterations: MAX_ITER, ...(HARNESS ? { tasks: true, memory: true, loop: true } : {}) });
          started = true;
          const wt = await waitIdle(task.ws);
          if (wt.peakRssMb > peakRss) peakRss = wt.peakRssMb;
          if (wt.procSplit) lastProcSplit = wt.procSplit;
          if (wt.sizeStr) lastSizeStr = wt.sizeStr;
          const afterTurn = listJsonlFiles(LOGS_DIR, task.ws);
          const turnFiles = [...afterTurn].filter(f => !beforeTurn.has(f));
          const tm = runMetrics(LOGS_DIR, task.ws, turnFiles);
          perTurn.push({
            turn: ti + 1, idle: wt.idle, wallMs: Date.now() - tTurn,
            status: tm.status ?? null,
            modelCallsTotal: tm.cost?.modelCallsTotal ?? null,
            promptTokensTotal: tm.promptTokensTotal ?? null,
            maxCtx: tm.maxCtx ?? null, frames: tm.frames ?? null,
            capHit: tm.friction?.capHit ?? null,
            topFrameTokenShare: tm.cost?.topFrameTokenShare ?? null,
          });
          if (!wt.idle) {
            idleAll = false;
            // A timed-out run is NOT actually stopped server-side — waitIdle just gave
            // up polling. Without this, the run keeps consuming the GPU in the
            // background and every subsequent task's own `reset` 409s ("Agent is busy")
            // for as long as the timed-out run happens to keep going — a real failure
            // mode hit in practice (one 30-min timeout cascaded into 3 more FAILs).
            try { await post(task.ws, 'stop', {}); } catch { /* best-effort */ }
            await sleep(2000);
            // Do not start a later turn on top of a run that had to be stopped: the session
            // state is unknown and the remaining turns would measure noise.
            break;
          }
        }
        const wallMs = Date.now() - tRun;
        const filesAfter = listJsonlFiles(LOGS_DIR, task.ws);
        const newFiles = [...filesAfter].filter(f => !filesBefore.has(f));
        // Scraped over EVERY log the whole task produced, across all turns — so the cost and
        // friction vectors describe the task, while `perTurn` above describes each turn.
        m = runMetrics(LOGS_DIR, task.ws, newFiles);
        if (!idleAll) m.status = 'TIMEOUT';
        m.wallMs = wallMs;
        // Resource peaks come from the per-turn waitIdle sampling; take the max across turns.
        m.peakRssMb = peakRss; m.procSplit = lastProcSplit; m.sizeStr = lastSizeStr;

        // ── GATES ─────────────────────────────────────────────────────────────────────
        const integrity = checkIntegrity({ task, wsDir, baseline: baselines[task.ws], strictExtraTests: STRICT_EXTRA_TESTS });
        const postSuite = suiteCmd ? runTests(suiteCmd, wsDir) : null;
        const regression = checkRegression(baselineSuite, postSuite);
        // Cross-check the task's TWO independent declarations of what it seeded: the
        // `testFile` list and the `cp` targets in `setup`. They must agree; a mismatch
        // means the gate is protecting a different file from the one being scored, which
        // is exactly the class of silent hole this batch exists to close.
        const declared = seededTestFiles(task).slice().sort();
        let fromSetup = null;
        try { fromSetup = seedTargets(task, wsDir).slice().sort(); } catch (e) { fromSetup = null; err = err || e.message; }
        const mismatch = fromSetup && JSON.stringify(declared) !== JSON.stringify(fromSetup)
          ? [`integrity-unevaluable: task.testFile ${JSON.stringify(declared)} != setup cp targets ${JSON.stringify(fromSetup)}`] : [];
        gates = {
          ok: integrity.ok && regression.ok && mismatch.length === 0,
          violations: [...integrity.violations, ...regression.violations, ...mismatch],
          warnings: integrity.warnings,
          checks: { ...integrity.checks, ...regression.checks, suiteCmd, baselineDoNothingPass: baselineSuite ? `${baselineSuite.pass}/${baselineSuite.total}` : null },
        };

        // ── TARGETED CORRECTNESS: seeded test cases only ──────────────────────────────
        const targets = fromSetup || declared;
        const seededCmd = seededCmdFor(targets);
        if (seededCmd) {
          targeted = runTests(seededCmd, wsDir);
          targetedFraction = targeted.fraction;
        } else if (typeof task.check === 'function') {
          // No file-based oracle (pure Q&A) — binary, against the run's own final answer.
          targetedFraction = task.check(m) ? 1 : 0;
        }

        // LEGACY pass/fail, recorded but not scored: keeps binary completion comparable
        // with the 33 pre-BATCH-1 rows even though the score deliberately is not.
        legacyCheck = typeof task.check === 'function' ? task.check(m) : shScore(task.check, wsDir).exitOk;

        // TYPE CHECK after the run. Enforced only where it held at baseline (see above), so
        // `typesAfter.enforced` records whether it counted rather than leaving that implicit.
        if (typesCmd) {
          const ok = shScore(typesCmd, wsDir).exitOk;
          typesAfter = { cmd: typesCmd, baselineOk: typesBaselineOk, ok, enforced: typesBaselineOk === true };
        }

        // A gate violation forces completed:false as well as score 0 — a gamed run, or a
        // run that broke something that passed at baseline, is not a pass. A task that asks
        // for TypeScript declarations is likewise not complete if they stopped compiling.
        // `idleAll` is false if ANY turn had to be stopped — a multi-turn task that timed out
        // on turn 2 is not a pass even if turn 1's tests still pass.
        completed = idleAll && gates.ok && targetedFraction === 1
          && (typesAfter?.enforced ? typesAfter.ok : true);

        // ── QUALITY (20 pts): saved artifacts must be captured BEFORE the final reset ──
        ledgerPath = saveLedger(task.ws, runId);
        // FRAME OUTCOMES (BATCH 2 / H13). Read from the ledger, not the event stream —
        // `deriveFrameResult`'s status is only written there. `partial` is the direct field
        // measurement of H13: the baseline it replaces is 43 September frames that ended
        // blank at their cap and were recorded `success`.
        frames = frameOutcomes(ledgerPath);
        diffInfo = saveDiff(task.ws, runId, baselines[task.ws]);
        const allowed = allowedFilesFor(task);
        const unreq = diffInfo.text == null ? null
          : unrequestedDiffRatio(diffInfo.text, { allowFiles: allowed.files, ignoreFiles: targets });
        if (JUDGE_ON) {
          // For a multi-turn task the objective is every turn's prompt in order — the judge is
          // asked whether the DIFF accomplished what was asked, and only turn 1's prompt would
          // make two thirds of the work look unrequested.
          const objective = turns.map(t => t.prompt).filter(Boolean).join('\n\n--- next turn ---\n\n');
          judgment = await judgeRun({ runId, taskId: task.id, objective, ledgerPath, diffText: diffInfo.text });
        }
        quality = qualityScore({ judgment, unrequestedRatio: unreq ? unreq.ratio : null });
        quality.allowFiles = allowed.files; quality.allowFilesSource = allowed.source;
        quality.changedLines = unreq ? unreq.changedLines : null;
        quality.outsideLines = unreq ? unreq.outsideLines : null;
        quality.perFileChangedLines = unreq ? unreq.perFile : null;

        rubric = rubricScore({ gate: gates, targetedFraction, qualityPoints: quality.points, passRate: null });
      } catch (e) {
        err = e.message;
        m.status = m.status || 'ERR';
      }

      if (!started) {
        // The run never happened. Do NOT write a history row — this is the defect that
        // put four fabricated failures into the flywheel's own memory.
        console.log(`SKIP  ${pad(model, 18)} ${pad(task.id, 24)} run never started — ${err}`);
        resetWs(task.ws, baselines[task.ws]);
        continue;
      }

      rubric = rubric || rubricScore({ gate: gates, targetedFraction, qualityPoints: quality?.points ?? null, passRate: null });
      const f = m.friction || {};
      console.log(
        `${completed ? 'DONE' : 'FAIL'}  ${pad(model, 18)} ${pad(task.id, 24)} ${pad(m.status ?? '?', 8)}`
        + ` gate=${gates.ok ? 'ok  ' : 'VOID'} c=${pad(num(rubric.correctness), 4)}/60 q=${pad(num(rubric.quality), 4)}/20`
        + ` it=${pad(m.iters ?? '?', 3)} tool=${pad(m.toolCalls ?? '?', 3)} frames=${pad(m.frames ?? '?', 2)} plan=${m.plan ?? '?'}`
        + ` | g=${pad(f.planGate ?? '?', 2)} role=${pad(f.roleReject ?? '?', 3)} L0/1/2=${f.loopL0 ?? '?'}/${f.loopL1 ?? '?'}/${f.loopL2 ?? '?'}`
        + ` dup=${pad(f.nearDup ?? '?', 3)} v+/-=${f.verifyPass ?? '?'}/${f.verifyFail ?? '?'} rt=${pad(f.gateRoundTrips ?? '?', 3)} cap=${f.capHit ?? '?'} w?=${f.warnUnmatched ?? '?'}`
        // BATCH 2 columns. part= is H13's field measurement (frames that hit their cap and
        // are no longer credited as success); pretry= is H17's Planner format retry;
        // tnv= is the Tester's missing-verdict escalation; pfail= is planning that stopped
        // rather than inventing a one-step plan; steps= is decomposition width.
        + ` | part=${pad(frames?.byStatus?.partial ?? '?', 2)} fail=${pad(frames?.byStatus?.failed ?? '?', 2)} nocon=${pad(frames?.delegationsWithoutConclusion ?? '?', 2)}`
        + ` pretry=${f.plannerFormatRetry ?? '?'} tnv=${f.testerNoVerdict ?? '?'} pfail=${f.planningFailed ?? '?'} steps=${m.decomposition?.taskGraphMaxSteps ?? '?'}`
        // COST — model calls and input tokens first, because they are confound-free; wall
        // clock trails as the aside it now is.
        + ` | calls=${pad(m.modelCallsTotal ?? '?', 3)} tok(in/out)=${pad(m.promptTokensTotal ?? '?', 7)}/${pad(m.cost?.genTokens ?? '?', 6)}`
        + ` wall=${pad(secs(m.wallMs), 6)} tok/s=${pad(m.tokPerSec ?? '?', 4)} ctx≈${pad(m.maxCtx ?? '?', 6)} cmp/ev=${m.compactions ?? '?'}/${m.evictions ?? '?'} rss=${pad((m.peakRssMb ? m.peakRssMb + 'MB' : '?'), 7)}`
        + `${err ? '  ERR: ' + err : ''}`,
      );
      for (const v of gates.violations) console.log(`      GATE ${v}`);
      for (const w2 of gates.warnings) console.log(`      note ${w2}`);
      // Both of these are TRIPWIRES: an unmatched message means a counter has gone blind to
      // a wording src/ now emits, which is how two metrics died silently for two months.
      // They print the offending prefixes so the fix is a copy-paste into metrics.mjs.
      if (f.warnUnmatched) console.log(`      !! UNMATCHED WARNING (counter blind spot) ${JSON.stringify(f.warnUnmatchedSamples)}`);
      if (f.errorsOther) console.log(`      !! UNCLASSIFIED ERROR ${JSON.stringify(f.errorsOtherSamples)}`);
      if (f.ladderFromProse) console.log(`      note loop ladder counted from PROSE (${f.ladderFromProse}) — this log predates 6884852's warning.level field`);
      if (f.unexpectedError) console.log(`      !! ${f.unexpectedError} UNEXPECTED ERROR(S) — a crash, not agent behaviour`);
      // ── CONTEXT / RUNAWAY-FRAME REPORT ──────────────────────────────────────────────
      // The failure mode this suite exists to provoke is a frame whose context grows without
      // bound until it never concludes. The aggregate hides it; these lines do not.
      const pf = m.cost?.perFrame ?? [];
      if (pf.length) {
        const top = pf[0];
        console.log(`      context: peak ${m.maxCtx ?? '?'} tok`
          + ` · heaviest frame ${top.role}/${top.status ?? '?'} = ${top.promptTokens} tok in ${top.modelCalls} call(s)`
          + ` (${Math.round(100 * (m.cost.topFrameTokenShare ?? 0))}% of tokens, ${Math.round(100 * (m.cost.topFrameCallShare ?? 0))}% of calls)`
          + ` · growth ${top.firstPromptTokens ?? '?'}->${top.lastPromptTokens ?? '?'} (${top.growthFactor ?? '?'}x)`
          + (top.accelAtCall ? ` · accelerated at call ${top.accelAtCall} (~${top.accelAtTokens} tok)` : ' · no acceleration knee'));
        // Directly tests the compaction-threshold hypothesis: Hermes compresses at 50% of its
        // window, Argo at ~94%. Counting calls above each line says whether a run actually
        // spent time in the regime the hypothesis blames. On the 2026-09-03 runaway frame the
        // answer was zero above even 50% — evidence AGAINST the threshold explanation for that
        // failure, which is why the counts are printed rather than assumed.
        const a50 = pf.reduce((a, p) => a + (p.callsAbove50Pct ?? 0), 0);
        const a75 = pf.reduce((a, p) => a + (p.callsAbove75Pct ?? 0), 0);
        const a94 = pf.reduce((a, p) => a + (p.callsAbove94Pct ?? 0), 0);
        console.log(`      context regime: calls above 50%/75%/94% of num_ctx = ${a50}/${a75}/${a94}`
          + ` · compactThreshold ${effective?.compactThreshold ?? '?'} (Hermes compresses at 0.5)`);
      }
      if (perTurn.length > 1) {
        console.log(`      turns: ${perTurn.map(t => `#${t.turn} ${t.modelCallsTotal ?? '?'}call/${t.promptTokensTotal ?? '?'}tok/peak${t.maxCtx ?? '?'}${t.idle ? '' : ' TIMEOUT'}`).join('  ')}`);
      }
      if (typesAfter) {
        console.log(`      typesCheck: ${typesAfter.ok ? 'ok' : 'FAIL'}${typesAfter.enforced ? '' : ' (not enforced — it did not pass at baseline either)'}`);
      }
      if (frames && frames.available) {
        const st = Object.entries(frames.byStatus).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ');
        console.log(`      frames ${st || '(none concluded)'} · ${frames.delegations} delegation(s), ${frames.resumed} resume(s)`
          + (frames.delegationsWithoutConclusion ? `, ${frames.delegationsWithoutConclusion} NEVER CONCLUDED` : '')
          + (frames.unknownStatus.length ? ` · UNKNOWN STATUS ${JSON.stringify(frames.unknownStatus)} — types.ts FrameStatus changed` : ''));
      }

      const row = {
        ts: new Date().toISOString(), batchId: BATCH_ID, runId, runIndex: i + 1, k: RUNS,
        rubricVersion: RUBRIC_VERSION,
        harness: 'argo', harnessSha: HARNESS_SHA + DIRTY, model,
        taskId: task.id, ws: task.ws, band: task.band ?? null, scored: isScored(task),
        // Schema fix (BATCH 1 item 5): agents, model, iteration budget and the RESOLVED
        // effective config on every row. Previously multi-agent runs, four accidental
        // single-loop runs and 17 backfilled rows were all pooled under one `argo` label,
        // so trend.mjs could not see the architecture comparison it was built for.
        agents: effective ? effective.agents : null,
        maxIterations: MAX_ITER, timeoutS: TIMEOUT_S, harnessFlagsFromEval: ['1', 'true', 'on', 'yes'].includes((process.env.EVAL_HARNESS || '').trim().toLowerCase()),
        effectiveConfig: effective,
        completed, legacyCheck,
        typesCheck: typesAfter,
        // Multi-turn (H25). `turns` is 1 for every ordinary task, so a query can filter on it
        // without special-casing. `perTurn` carries each prompt's own cost and peak context —
        // the series that makes "did it retain turn N-1's understanding" answerable.
        turns: turnsOf(task).length, multiTurn: isMultiTurn(task), perTurn,
        score: rubric.total,          // null until the batch aggregation supplies passRate
        runScore: rubric.runScore, runScoreMax: rubric.runScoreMax,
        scoreBreakdown: rubric,
        gates,
        targeted: targeted
          ? { pass: targeted.pass, fail: targeted.fail, total: targeted.total, fraction: targeted.fraction, reporter: targeted.reporter, cmd: targeted.cmd }
          : { pass: null, fail: null, total: null, fraction: targetedFraction, reporter: null, cmd: null },
        quality,
        // Spread metrics.mjs's cost vector rather than re-listing fields: it is the single
        // definition of the cost metrics (modelCallsTotal, promptTokensTotal, cacheReuse,
        // …) and re-enumerating them here is how a new field silently fails to reach the
        // ledger. Only the host-sampled values, which metrics.mjs cannot see, are added.
        cost: {
          ...(m.cost ?? {}),
          wallMs: m.wallMs ?? null,
          peakRssMb: m.peakRssMb ?? null, procSplit: m.procSplit ?? null, sizeStr: m.sizeStr ?? null,
          ollamaAtStart,
        },
        friction: m.friction ?? null,
        // Decomposition width — free to record, and it is BATCH 2's exit criterion.
        // Baseline to beat, measured over the September logs: 84 of 85 task graphs had
        // exactly one step. First post-BATCH-2 live run: 3 steps.
        decomposition: m.decomposition ?? null,
        // BATCH 2 / H13 frame outcomes, from the ledger. `frameOutcomes.byStatus.partial`
        // is the first-class number: how many frames hit their cap and are no longer
        // credited as `success`. Baseline being replaced: 43 such frames in September, all
        // recorded success (Planner 9/23 = 39%).
        frameOutcomes: frames,
        counterSelfCheck: counterCheck.ok ? 'ok' : 'FAIL',
        status: m.status ?? null, plan: m.plan ?? null,
        // Repaired in place under their ORIGINAL names so existing jq/eval-log recipes
        // (g=/r=/s=) keep working and now carry real numbers instead of artifacts.
        gate: (f.planGate ?? 0) + (f.legacyPlanGate ?? 0),
        reground: f.reground ?? null,
        steer: (f.loopL0 ?? 0) + (f.loopL1 ?? 0) + (f.loopL2 ?? 0) + (f.legacySteer ?? 0),
        iters: m.iters ?? null, toolCalls: m.toolCalls ?? null, frames: m.frames ?? null,
        compactions: m.compactions ?? null, wallMs: m.wallMs ?? null, tokPerSec: m.tokPerSec ?? null,
        maxCtx: m.maxCtx ?? null, peakRssMb: m.peakRssMb ?? null,
        artifacts: { ledger: ledgerPath, diff: diffInfo.path, judgment: judgment?.outPath ?? null },
        err: err ?? null,
      };
      appendHistory(row);
      rows.push(row);
      resetWs(task.ws, baselines[task.ws]);
    }
  }
  console.log('');
}

// ── Batch aggregation (EVAL-PLAN §3.1 / §4.3) ─────────────────────────────────────────
// The composite 0-100 score exists only HERE, because reliability is a pass rate over the
// k runs in this batch. A single run yields correctness + quality (max 80) and nothing
// else; that is the point.
console.log('=== per-task scorecard (rubric v2: 60 targeted correctness + 20 quality + 20 reliability) ===');
console.log(pad('model', 18) + pad('task', 24) + pad('band', 8) + pad('n', 3) + pad('pass', 6) + pad('c/60', 7) + pad('q/20', 7) + pad('rel/20', 8) + pad('TOTAL', 7) + 'wall mean  flags');
// ── Band verdicts (BATCH 1b item 3) ───────────────────────────────────────────────────
// The first live run printed `out-of-band (declared mid), floor` for bigproj-observability.
// Diagnosis: that was the FLAG being wrong, not the label. It ran at k=1, the single run was
// gate-voided, so the measured pass rate was 0/1 — and declaring a task out of its band from
// one sample is precisely the n=1 inference this whole programme exists to remove. A label
// churned on n=1 evidence is worse than a stale label, because it destroys the record of
// what the task was believed to be.
//
// So the verdict is now ESTIMABLE-GATED and, when estimable, LOUD:
//   k < 3   → no band verdict at all, only `band n/e (k=<n>)`. Same rule as the composite
//             score, which is already null below k=3 for the same reason.
//   k >= 3  → the measured band is computed and compared with the declaration; a mismatch
//             is its own console line, counted at batch level, and sets a non-zero exit
//             code — the same treatment as the counter self-check, because a wrong band
//             label makes the difficulty distribution unreadable and the distribution is
//             the one thing the suite exists to show.
// No declaration is edited here: `observed` values are priors from pre-BATCH-1 runs and
// remain the best available until a k>=3 battery replaces them. When one does, the exit code
// is how you find out which ones to change.
//
// The boundaries are EVAL-PLAN §3.2's, widened so that the four pass rates actually
// achievable at k=3 each land in exactly one band. §3.2's literal ranges do not: at k=3 the
// only possible values are 0, 1/3, 2/3 and 1, and 1/3 = 0.333 falls outside its `hard`
// [0.1, 0.3] — so every hard task would have been reported as a mismatch by arithmetic
// rather than by behaviour. `hard` is therefore [0.1, 0.35]. `floor` and `easy` both contain
// 1.0 by design (a floor probe is an easy task that must never fail); they are disambiguated
// by `scored`, not by the rate, so a task is judged only against ITS OWN declared range
// instead of being assigned a single derived name.
const BAND_RANGES = {
  floor: [1.0, 1.0],
  easy: [0.85, 1.0],
  mid: [0.4, 0.7],
  hard: [0.1, 0.35],
  ceiling: [0.0, 0.05],
};
// null when the band name is unknown — an unknown declaration is a mismatch of a different
// kind and is reported as such rather than silently passing.
const inBand = (band, p) => {
  const r = BAND_RANGES[band];
  return r ? (p >= r[0] && p <= r[1]) : null;
};
const bandsContaining = (p) => Object.entries(BAND_RANGES).filter(([, r]) => p >= r[0] && p <= r[1]).map(([n]) => n);
const batchTotals = new Map(MODELS.map(mm => [mm, { scored: [], mid: 0, pass: 0, n: 0, voided: 0, bandMismatch: [] }]));
for (const model of MODELS) {
  for (const task of SUITE) {
    const rs = rows.filter(r => r.model === model && r.taskId === task.id);
    if (!rs.length) continue;
    const passRate = rs.filter(r => r.completed).length / rs.length;
    const cs = rs.map(r => r.scoreBreakdown.correctness).filter(x => x != null);
    const qs = rs.map(r => r.scoreBreakdown.quality).filter(x => x != null);
    const meanC = cs.length === rs.length ? mean(cs) : null;
    const meanQ = qs.length === rs.length ? mean(qs) : null;
    const agg = rubricScore({ gate: { ok: true }, targetedFraction: meanC == null ? null : meanC / 60, qualityPoints: meanQ, passRate });
    const wall = mean(rs.map(r => r.wallMs).filter(x => x != null));
    const voided = rs.filter(r => !r.scoreBreakdown.gatePassed).length;
    const flags = [];
    if (voided) flags.push(`${voided} VOIDED`);
    if (passRate === 1) flags.push('saturated');
    if (passRate === 0) flags.push('floor');
    if (passRate >= 0.4 && passRate <= 0.7) flags.push('MID BAND');
    // Band verdict: only when k >= 3 (see BAND_RANGES above for why).
    let bandVerdict = null;
    if (rs.length < 3) {
      flags.push(`band n/e (k=${rs.length})`);
    } else if (task.band) {
      const ok = inBand(task.band, passRate);
      if (ok === null) {
        bandVerdict = `unknown band name "${task.band}"`;
        flags.push(`BAND MISMATCH: declared band "${task.band}" is not one of ${Object.keys(BAND_RANGES).join('/')}`);
      } else if (!ok) {
        const also = bandsContaining(passRate);
        bandVerdict = `p=${passRate.toFixed(2)}${also.length ? ` (in ${also.join('/')})` : ' (in no declared band)'}`;
        flags.push(`BAND MISMATCH: declared ${task.band} [${BAND_RANGES[task.band].join('-')}], measured ${bandVerdict}`);
      }
    }
    if (agg.incomplete.length) flags.push(`no total: missing ${agg.incomplete.join('+')}`);
    if (rs.some(r => r.friction && r.friction.warnUnmatched > 0)) flags.push('unmatched warnings');
    if (rs.some(r => r.friction && r.friction.unexpectedError > 0)) flags.push('CRASH');
    const partials = rs.reduce((a, r) => a + (r.frameOutcomes?.byStatus?.partial ?? 0), 0);
    if (partials) flags.push(`${partials} partial frame(s)`);
    if (rs.some(r => r.friction && r.friction.plannerFormatRetry > 0)) {
      const pr = rs.filter(r => r.friction && r.friction.plannerFormatRetry > 0).length;
      flags.push(`planner format retry in ${pr}/${rs.length}`);
    }
    console.log(
      pad(model, 18) + pad(task.id, 24) + pad(task.band ?? '?', 8) + pad(rs.length, 3)
      + pad(`${rs.filter(r => r.completed).length}/${rs.length}`, 6)
      + pad(num(meanC), 7) + pad(num(meanQ), 7) + pad(num(agg.reliability), 8)
      + pad(agg.total == null ? '—' : agg.total, 7) + pad(secs(wall), 11) + flags.join(', '),
    );
    const bt = batchTotals.get(model);
    bt.n += rs.length; bt.pass += rs.filter(r => r.completed).length; bt.voided += voided;
    if (bandVerdict) bt.bandMismatch.push(`${task.id}: declared ${task.band}, measured ${bandVerdict} (${rs.filter(r => r.completed).length}/${rs.length})`);
    if (isScored(task)) {
      if (agg.total != null) bt.scored.push(agg.total);
      if (passRate >= 0.4 && passRate <= 0.7) bt.mid++;
    }
  }
}
console.log('');
for (const model of MODELS) {
  const bt = batchTotals.get(model);
  const batchMean = bt.scored.length ? Math.round(mean(bt.scored)) : null;
  console.log(`${pad(model, 22)} ${bt.pass}/${bt.n} run(s) completed · ${bt.voided} voided by a gate · batch score ${batchMean == null ? 'NOT COMPUTABLE' : `${batchMean}/100`} over ${bt.scored.length} scored task(s) · mid-band tasks: ${bt.mid}`);
  // PLAN standing rule: "If the mid-band count is 0, the batch is not a measurement."
  if (bt.mid === 0) console.log(`${pad('', 22)} !! mid-band count is 0 — this batch discriminates nothing. Do not draw conclusions from it (EVAL-PLAN §4.3).`);
  if (RUNS < 3) console.log(`${pad('', 22)} !! k=${RUNS} < 3 — reliability is not estimable, and no band verdict is issued; smoke test only, never evidence.`);
  // A wrong band label makes the difficulty distribution unreadable, and the distribution is
  // the one thing the suite exists to show — so this is not a soft note. Same exit-code
  // treatment as the counter self-check.
  if (bt.bandMismatch.length) {
    console.log(`${pad('', 22)} !! ${bt.bandMismatch.length} BAND MISMATCH(ES) — correct the \`band\`/\`observed\` declarations in tasks.mjs from these measurements:`);
    for (const b of bt.bandMismatch) console.log(`${pad('', 25)} ${b}`);
    process.exitCode = 1;
  }
}
// Counter blind spots and crashes get the same exit-code treatment, for the same reason: a
// silent zero is the failure mode BATCH 1 was built to remove, so it must not be possible to
// finish a green-looking battery with one in it.
const anyUnmatched = rows.reduce((a, r) => a + (r.friction?.warnUnmatched ?? 0) + (r.friction?.errorsOther ?? 0), 0);
const anyCrash = rows.reduce((a, r) => a + (r.friction?.unexpectedError ?? 0), 0);
if (anyUnmatched) { console.log(`\n!! ${anyUnmatched} unmatched warning/error message(s) across this batch — metrics.mjs has a blind spot. Prefixes are printed per run above.`); process.exitCode = 1; }
if (anyCrash) { console.log(`!! ${anyCrash} unexpected error(s) — a crash, not agent behaviour.`); process.exitCode = 1; }
// H13/H17 batch summary — the two Batch 2 hypotheses, as one line each.
const partialTotal = rows.reduce((a, r) => a + (r.frameOutcomes?.byStatus?.partial ?? 0), 0);
const framesTotal = rows.reduce((a, r) => a + (r.frameOutcomes?.conclusions ?? 0), 0);
const retryTotal = rows.reduce((a, r) => a + (r.friction?.plannerFormatRetry ?? 0), 0);
const pfailTotal = rows.reduce((a, r) => a + (r.friction?.planningFailed ?? 0), 0);
const graphRows = rows.filter(r => (r.decomposition?.taskGraphs ?? 0) > 0);
const multiStep = graphRows.filter(r => (r.decomposition?.taskGraphMaxSteps ?? 0) >= 2).length;
// ── COST SUMMARY (the primary metric) ─────────────────────────────────────────────────
// Model calls and tokens, per task, in the same layout hermes.mjs prints — so the two
// scorecards can be read side by side without a join. These are the confound-free numbers:
// unaffected by Docker, host access, --yolo, CPU/GPU split, or a model reload.
console.log('\n=== cost (per task, mean over k) — compare with the Hermes scorecard\'s calls/tok columns ===');
console.log(pad('task', 26) + pad('calls', 8) + pad('tok in', 10) + pad('tok out', 9) + pad('ms/tok*', 9) + pad('tools', 7) + pad('wall', 7) + 'cache reuse (near/high/mid/low/none)');
for (const task of SUITE) {
  const rs = rows.filter(r => r.taskId === task.id && r.cost && r.cost.modelCallsTotal != null);
  if (!rs.length) continue;
  const avg = (f) => { const v = rs.map(r => r.cost[f]).filter(x => x != null); return v.length ? Math.round(mean(v)) : null; };
  const cr = ['reuseNearTotal', 'reuseHigh', 'reuseMid', 'reuseLow', 'reuseNone']
    .map(b => rs.reduce((a, r) => a + (r.cost.cacheReuse?.[b] ?? 0), 0)).join('/');
  const msTok = mean(rs.map(r => r.cost.promptMsPerTokenUpperBound).filter(x => x != null));
  console.log(pad(task.id, 26) + pad(avg('modelCallsTotal') ?? '?', 8) + pad(avg('promptTokensTotal') ?? '?', 10)
    + pad(avg('genTokens') ?? '?', 9) + pad(msTok == null ? '?' : msTok.toFixed(2), 9)
    + pad(avg('toolCalls') ?? '?', 7) + pad(`${Math.round((avg('wallMs') ?? 0) / 1000)}s`, 7) + cr);
}
const bCalls = rows.reduce((a, r) => a + (r.cost?.modelCallsTotal ?? 0), 0);
const bIn = rows.reduce((a, r) => a + (r.cost?.promptTokensTotal ?? 0), 0);
const bAux = rows.reduce((a, r) => a + (r.cost?.auxModelCalls ?? 0), 0);
const bRetry = rows.reduce((a, r) => a + (r.cost?.ollamaRetries ?? 0), 0);
console.log(`\nBATCH COST — ${bCalls} model call(s) (${bCalls - bAux - bRetry} main-loop + ${bRetry} retry + ${bAux} critic), ${bIn} input token(s) over ${rows.length} run(s).`);
console.log(`  * ms/tok is an UPPER BOUND: (total_duration_ms - eval_duration_ms)/prompt_tokens, which also contains load_duration.`);
console.log(`    A clean prefix-cache measurement needs prompt_eval_duration_ms added to the token_usage event (agent.ts:1534).`);
if (rows.some(r => r.friction?.modelCallsVsItersDisagree > 0)) {
  console.log('!! ollama_request and iteration counts disagreed on at least one frame — trust cost.modelCalls over cost.iters and check the emit sites.');
  process.exitCode = 1;
}
console.log(`\nH13 (cap-hit visibility): ${partialTotal} partial of ${framesTotal} concluded frame(s). Baseline replaced: 43 September frames ended blank at their cap and were recorded success.`);
console.log(`H17 (Planner readability): ${retryTotal} format retry/retries, ${pfailTotal} planning failure(s); ${multiStep}/${graphRows.length} run(s) produced a >=2-step graph. Baseline: 84 of 85 September graphs had exactly 1 step.`);

// Ready-to-paste block for docs/eval-log.md — the flywheel's memory.
const date = new Date().toISOString().slice(0, 10);
console.log(`\n--- eval-log entry (paste into docs/eval-log.md) ---`);
console.log(`### ${date} — E2E — harness \`${HARNESS_SHA}${DIRTY}\` — rubric v${RUBRIC_VERSION} — batch \`${BATCH_ID}\``);
console.log(`Models: ${MODELS.join(', ')} · k=${RUNS} run(s)/task · ${SUITE.length} task(s) · max_iter ${MAX_ITER} · timeout ${TIMEOUT_S}s · judge ${JUDGE_ON ? 'on' : 'OFF'}`);
console.log(`NOT comparable with any pre-2026-09-03 score: rubric v1 (70/15/15 incl. speed) → v2 (60/20/20, speed removed, two binary gates). Pass/fail IS comparable (see \`legacyCheck\`).`);
for (const model of MODELS) {
  const bt = batchTotals.get(model);
  const batchMean = bt.scored.length ? Math.round(mean(bt.scored)) : null;
  console.log(`- ${model}: ${bt.pass}/${bt.n} completed · ${bt.voided} gate-voided · batch ${batchMean == null ? 'n/a' : `${batchMean}/100`} · mid-band ${bt.mid}`);
}
console.log(`- Cost: <wall-clock, turns, tok/s, peak ctx, peak rss, CPU/GPU split from the rows above>`);
console.log(`- Friction: <planGate / roleReject / L0-L1-L2 / nearDup / verifyFail / gateRoundTrips / capHit totals>`);
console.log(`- Notes: <what changed since last run; notable per-task behaviour>`);

async function post(ws, route, body) {
  const r = await fetch(`${URL_BASE}/ws/${ws}/${route}`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`POST /ws/${ws}/${route} → ${r.status} (is the workspace attached? run: argo ${wsPath(ws)})`);
  return r.json().catch(() => ({}));
}

async function get(ws, route) {
  const r = await fetch(`${URL_BASE}/ws/${ws}/${route}`, { headers: authHeaders });
  if (!r.ok) throw new Error(`GET /ws/${ws}/${route} → ${r.status} (is the workspace attached? run: argo ${wsPath(ws)})`);
  return r.json();
}
