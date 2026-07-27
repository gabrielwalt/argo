#!/usr/bin/env node
/**
 * Argo END-TO-END eval — runs REAL Argo agent loops and scores whether the model
 * actually COMPLETED the task (a check command exits 0), plus quality AND cost
 * metrics from the run log and the host: turns, tool calls, plan, harness
 * interventions, peak context, compactions, wall-clock, generation throughput,
 * peak memory, and CPU/GPU split. This is the slow, truthful layer that
 * complements the fast single-turn probe in eval.mjs — where "can a small model
 * do a hard, long task without drifting, and at what cost" is actually measured.
 *
 * Tasks are made NON-TRIVIAL and self-verifying via a `setup` step that seeds a
 * FAILING test. Completion = the agent implemented it so the whole suite passes.
 *
 * Per model × task × run: reset workspace to baseline → run task.setup → POST
 * /ws/<name>/reset → POST /ws/<name>/chat → poll /ws/<name>/status until idle
 * (sampling host resources meanwhile) → run task.check → read newest run log for
 * metrics → reset. Prints a per-model scorecard, stamped with the harness git SHA,
 * plus a ready-to-paste docs/eval-log.md block.
 *
 * ⚠️ DESTRUCTIVE: between runs it does `git reset --hard <baseline> && git clean -fd`
 * in each workspace. Only run on repos whose current HEAD is the baseline you want.
 * Runs on the HOST (Argo running with workspaces ATTACHED, Ollama reachable, password known).
 *
 * Usage:
 *   ARGO_PASSWORD=... npm run eval:e2e
 *   ARGO_PASSWORD=... EVAL_MODELS="qwen3.6:latest,<candidate>" EVAL_RUNS=2 npm run eval:e2e
 * Env: ARGO_URL(http://localhost:3000) ARGO_PASSWORD(req) ARGO_LOGS_DIR(~/.local/share/argo/logs)
 *   ARGO_WS_ROOT(~/Sources/test) EVAL_MODELS EVAL_RUNS EVAL_MAX_ITER(60) EVAL_TIMEOUT_S(900)
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const URL_BASE = process.env.ARGO_URL || 'http://localhost:3000';
const PASSWORD = process.env.ARGO_PASSWORD;
// Default target model is qwen3.6 (the validated agentic model). Pass EVAL_MODELS to
// vet a candidate (a newer qwen, or any new local model) against the same tasks.
const MODELS = (process.env.EVAL_MODELS || 'qwen3.6:latest').split(',').map(s => s.trim()).filter(Boolean);
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS || 1));
const MAX_ITER = Number(process.env.EVAL_MAX_ITER || 60);
const TIMEOUT_S = Number(process.env.EVAL_TIMEOUT_S || 900);
const LOGS_DIR = process.env.ARGO_LOGS_DIR || path.join(os.homedir(), '.local/share/argo/logs');
const WS_ROOT = process.env.ARGO_WS_ROOT || path.join(os.homedir(), 'Sources/test');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(REPO, 'scripts/eval-fixtures');
const OPTS = { temperature: 0.8, top_p: 0.9, top_k: 40, num_ctx: 65536 };
const HARNESS_SHA = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim(); } catch { return 'nogit'; } })();
const DIRTY = (() => { try { return execSync('git status --porcelain', { cwd: REPO }).toString().trim().length > 0 ? '+dirty' : ''; } catch { return ''; } })();

if (!PASSWORD) { console.error('Set ARGO_PASSWORD (Argo sign-in password).'); process.exit(1); }

// Real, self-verifying tasks. `setup(wsDir)` runs in the workspace to seed a failing
// test; `check` (also in the workspace) must exit 0 = task completed. Graded/harder
// tasks (long-horizon multi-file features, misdirection bugs, under-specified specs,
// and the open-ended sim-debug) are added over time to keep the eval from saturating.
const TASKS = [
  { id: 'store-addTask', ws: 'test-one',
    setup: () => `cp "${path.join(FIXTURES, 'task-store-addTask.test.js')}" test/task-store-addTask.test.js`,
    prompt: 'The test suite has a new failing test at test/task-store-addTask.test.js expecting an exported function addTask(tasks, title) in src/task-store.js. Implement addTask so the FULL test suite passes: it must return a NEW array (never mutating its input) with a task appended, shaped { id: nextId(tasks), title, done: false, createdAt: <ISO timestamp string> }.',
    check: 'npm test' },
  { id: 'store-removeTask', ws: 'test-one',
    setup: () => `cp "${path.join(FIXTURES, 'task-store-removeTask.test.js')}" test/task-store-removeTask.test.js`,
    prompt: 'The test suite has a new failing test at test/task-store-removeTask.test.js expecting an exported function removeTask(tasks, id) in src/task-store.js that returns a NEW array without the task whose id matches (not mutating the input). Implement it so the full test suite passes.',
    check: 'npm test' },
  // HARD, long-horizon: a multi-part dependency-graph feature (real algorithm).
  { id: 'store-deps', ws: 'test-one',
    setup: () => `cp "${path.join(FIXTURES, 'task-store-deps.test.js')}" test/task-store-deps.test.js`,
    prompt: 'The test suite has a new failing test at test/task-store-deps.test.js. Read it and src/task-store.js first, then implement THREE exported functions in src/task-store.js so the FULL suite passes (do not weaken tests):\n' +
      '- addDependency(tasks, id, dependsOnId): return a NEW tasks array (never mutating the input) where the task with `id` gains `dependsOnId` in its `deps` array (create deps:[] if absent). Throw an Error if `id` or `dependsOnId` is not an existing task, or if adding it would create a cycle (including a self-dependency).\n' +
      '- getReadyTasks(tasks): return the tasks that are not done and whose every dependency (task id listed in `deps`) refers to a task that is done. A not-done task with no deps is ready.\n' +
      '- hasCycle(tasks): return true if the dependency graph (each task\'s `deps`) contains a cycle, else false.',
    check: 'npm test' },
  // BIG project (tasklab, ~827 LOC, 11 modules) — a complex cross-cutting feature
  // (dependency graph + topological scheduling + cycle detection on TaskService).
  { id: 'bigproj-deps', ws: 'bigproj',
    setup: () => `cp "${path.join(FIXTURES, 'bigproj-dependencies.test.js')}" test/dependencies.test.js`,
    prompt: 'Implement task dependencies in the tasklab project. On TaskService (in src/service.js) add addDependency(taskId, dependsOnId), removeDependency(taskId, dependsOnId), getDependencies(taskId), getDependents(taskId), scheduleOrder(), and readyTasks(). addDependency(X, Y) means "X depends on Y" (Y must be done before X) and stores Y in X.dependsOn via the store. Validate both tasks exist (NotFoundError); reject self-dependencies (ConflictError code SELF_DEPENDENCY), duplicates (DUPLICATE_DEPENDENCY), and edges that would create a cycle (DEPENDENCY_CYCLE). scheduleOrder() returns all task ids in a deterministic topological order (prerequisites first, ties broken by creation order); readyTasks() returns the not-done tasks whose every prerequisite is already done. Read test/dependencies.test.js and src/service.js first, then make the full suite pass with node --test without weakening tests.',
    check: 'npm test' },
  // HARD, long-horizon: effort estimates threaded through validation, the task
  // entity, the service, and the query layer (multi-file; stresses memory/convergence).
  { id: 'bigproj-effort', ws: 'bigproj',
    setup: () => `cp "${path.join(FIXTURES, 'bigproj-effort.test.js')}" test/effort.test.js`,
    prompt: 'Add effort estimates to the tasklab project. Tasks gain an integer field estimateMinutes (minutes, >= 0, default 0). Thread it through validation and creation so create({ title, estimateMinutes }) and update(id, { estimateMinutes }) accept it and reject a non-integer or negative value with a ValidationError. On TaskService add setEstimate(id, minutes) (validate the value, throw NotFoundError for an unknown id, return the updated task) and getEstimate(id) (return the estimateMinutes, default 0). In src/query.js add totalEstimate(tasks) (sum of estimateMinutes), remainingEffort(tasks) (sum over tasks whose status is not "done"), and estimateByAssignee(tasks) (an object mapping each assignee to summed estimateMinutes over NOT-done tasks, keyed "unassigned" for a null assignee). A failing spec is at test/effort.test.js — read it and the relevant src modules first, then make the full suite pass with node --test without weakening tests.',
    check: 'npm test' },
  // DEBUG (latent bug in committed code — no revert shortcut): a null-dueDate
  // sort-direction defect in src/query.js. Symptom is a failing sort test; the
  // cause is the direction factor being applied to the null sentinel.
  { id: 'bigproj-duedate-bug', ws: 'bigproj',
    setup: () => `cp "${path.join(FIXTURES, 'bigproj-duedate-sort.test.js')}" test/duedate-sort.test.js`,
    prompt: 'The tasklab test suite has a failing spec at test/duedate-sort.test.js: when sorting by dueDate, tasks with a null dueDate must appear LAST in both ascending and descending order, but in descending order they currently jump to the front. Read the failing test and src/query.js, find the root cause of how the sort direction is applied to the null sentinel, and fix it so nulls stay last in both directions without breaking the existing sort tests. Make the full suite pass with node --test.',
    check: 'npm test' },
];

const authHeaders = { 'content-type': 'application/json', 'x-argo-password': PASSWORD };
const wsPath = (ws) => path.join(WS_ROOT, ws);
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
const shOk = (cmd, cwd) => { try { execSync(cmd, { cwd, stdio: 'pipe' }); return true; } catch { return false; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Prefer an explicit `eval-baseline` tag over "current HEAD" so a run interrupted
// between the agent's auto-commit and the reset can't leave a polluted commit as
// the next baseline. Tag each eval workspace once: `git tag -f eval-baseline`.
const baselineOf = (ws) => {
  try { return sh('git rev-parse eval-baseline', wsPath(ws)).trim(); } catch { /* no tag */ }
  try { return sh('git rev-parse HEAD', wsPath(ws)).trim(); } catch { return null; }
};
const resetWs = (ws, base) => { if (base) { try { sh(`git reset --hard ${base} && git clean -fd`, wsPath(ws)); } catch (e) { console.error(`reset ${ws}:`, e.message); } } };

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

// Scrape per-run quality + cost from the newest JSONL log. The three intervention
// counters are HEALTHY harness activity, not failures — keep them distinct from a
// true "stall" (a model that narrates and stops, which emits no warning and shows up
// as low iters + plan=0 + FAIL).
//   gate     — plan/act gate fired (tried to mutate the project before planning)
//   reground — done-gate nudge fired (verify the objective before finishing)
//   steer    — loop-steer fired (identical call, no new information)
//   cmp      — compactions over the run
//   tok/s    — generation throughput; needs the harness to log Ollama eval_duration
//              (token_usage.eval_duration_ms). "?" until that lands — see roadmap Phase 3(b).
function newestRunMetrics(ws) {
  const dir = path.join(LOGS_DIR, ws);
  let files; try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch { return {}; }
  const f = files[files.length - 1];
  if (!f) return {};
  let meta = {}, plan = 0, iters = 0, gate = 0, reground = 0, steer = 0, errors = 0;
  let maxCtx = 0, compactions = 0, genTokens = 0, genMs = 0;
  for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line).event || {}; } catch { continue; }
    if (e.type === '__meta__') meta = e;
    else if (e.type === 'plan') plan++;
    else if (e.type === 'iteration') iters = e.current;
    else if (e.type === 'error') errors++;
    else if (e.type === 'compact') compactions++;
    else if (e.type === 'token_usage') {
      maxCtx = Math.max(maxCtx, e.prompt_tokens || 0);
      genTokens += e.generated_tokens || 0;
      genMs += e.eval_duration_ms || 0;
    } else if (e.type === 'warning') {
      const msg = e.message || '';
      if (/record a plan|changing the project/i.test(msg)) gate++;
      else if (/re-ground/i.test(msg)) reground++;
      else if (/no new information|STOP —/i.test(msg)) steer++;
    }
  }
  const tokPerSec = genMs > 0 ? Math.round(genTokens / (genMs / 1000)) : null;
  return { status: meta.status, iters, toolCalls: meta.toolCalls, plan, gate, reground, steer, maxCtx, compactions, tokPerSec, errors };
}

const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
const secs = (ms) => ms != null ? `${Math.round(ms / 1000)}s` : '?';

console.log(`Argo E2E eval — harness ${HARNESS_SHA}${DIRTY} — ${MODELS.length} model(s) × ${TASKS.length} task(s) × ${RUNS} run(s) — ${URL_BASE}\n`);
const baselines = Object.fromEntries([...new Set(TASKS.map(t => t.ws))].map(ws => [ws, baselineOf(ws)]));
const score = new Map(MODELS.map(m => [m, { pass: 0, total: 0 }]));

for (const model of MODELS) {
  for (const task of TASKS) {
    for (let i = 0; i < RUNS; i++) {
      resetWs(task.ws, baselines[task.ws]);
      let completed = false, m = {};
      try {
        if (task.setup) sh(task.setup(wsPath(task.ws)), wsPath(task.ws));  // seed the failing test
        await post(task.ws, 'reset', {});
        const tRun = Date.now();
        await post(task.ws, 'chat', { message: task.prompt, model, options: OPTS, maxIterations: MAX_ITER });
        const w = await waitIdle(task.ws);
        const wallMs = Date.now() - tRun;
        completed = w.idle && shOk(task.check, wsPath(task.ws));
        m = newestRunMetrics(task.ws);
        if (!w.idle) m.status = 'TIMEOUT';
        m.wallMs = wallMs; m.peakRssMb = w.peakRssMb; m.procSplit = w.procSplit; m.sizeStr = w.sizeStr;
      } catch (e) { m = { status: 'ERR', err: e.message }; }
      score.get(model).total++; if (completed) score.get(model).pass++;
      console.log(
        `${completed ? 'DONE' : 'FAIL'}  ${pad(model, 18)} ${pad(task.id, 16)} ${pad(m.status ?? '?', 8)}`
        + ` it=${pad(m.iters ?? '?', 3)} tool=${pad(m.toolCalls ?? '?', 3)} plan=${m.plan ?? '?'} g=${m.gate ?? '?'} r=${m.reground ?? '?'} s=${m.steer ?? '?'} cmp=${m.compactions ?? '?'}`
        + ` | wall=${pad(secs(m.wallMs), 5)} tok/s=${pad(m.tokPerSec ?? '?', 4)} ctx≈${pad(m.maxCtx ?? '?', 6)} rss=${pad((m.peakRssMb ? m.peakRssMb + 'MB' : '?'), 7)} ${m.procSplit ?? ''}`
        + `${m.err ? '  ' + m.err : ''}`,
      );
      resetWs(task.ws, baselines[task.ws]);
    }
  }
  console.log('');
}
console.log('=== scorecard (task completion — implemented so the suite passes) ===');
for (const model of MODELS) { const s = score.get(model); console.log(`${pad(model, 22)} ${s.pass}/${s.total} completed (${Math.round(100 * s.pass / s.total)}%)`); }

// Ready-to-paste block for docs/eval-log.md — the flywheel's memory.
const date = new Date().toISOString().slice(0, 10);
console.log(`\n--- eval-log entry (paste into docs/eval-log.md) ---`);
console.log(`### ${date} — E2E — harness \`${HARNESS_SHA}${DIRTY}\``);
console.log(`Models: ${MODELS.join(', ')} · ${RUNS} run(s)/task · max_iter ${MAX_ITER} · task completion + cost`);
for (const model of MODELS) { const s = score.get(model); console.log(`- ${model}: ${s.pass}/${s.total} completed (${Math.round(100 * s.pass / s.total)}%)`); }
console.log(`- Cost: <wall-clock, tok/s, peak ctx, peak rss, CPU/GPU split from the rows above>`);
console.log(`- Notes: <what changed since last run; notable per-task behaviour>`);

async function post(ws, route, body) {
  const r = await fetch(`${URL_BASE}/ws/${ws}/${route}`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`POST /ws/${ws}/${route} → ${r.status} (is the workspace attached? run: argo ${wsPath(ws)})`);
  return r.json().catch(() => ({}));
}
