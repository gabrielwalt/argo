#!/usr/bin/env node
/**
 * Argo END-TO-END eval — runs REAL Argo agent loops and scores whether the small
 * model actually COMPLETED the task (a check command exits 0), plus behaviour
 * metrics from the run log (turns, tool calls, plan recorded, harness
 * interventions, peak context). This is the slow, truthful layer that complements
 * the fast single-turn probe in eval.mjs — it's where "can a small model do a
 * multi-step task without drifting" is actually measured.
 *
 * Tasks are made NON-TRIVIAL and self-verifying via a `setup` step that seeds a
 * FAILING test (a spec for a function that doesn't exist yet). Completion = the
 * agent implemented it so the whole suite passes — it cannot pass by doing nothing.
 *
 * Per model × task × run: reset workspace to baseline → run task.setup (seed the
 * failing test) → POST /ws/<name>/reset → POST /ws/<name>/chat {message, model} →
 * poll /ws/<name>/status until idle → run task.check in the workspace → read newest
 * run log for metrics → reset workspace. Prints a per-model completion scorecard,
 * stamped with the harness git SHA, plus a ready-to-paste docs/eval-log.md block.
 *
 * ⚠️ DESTRUCTIVE: between runs it does `git reset --hard <baseline> && git clean -fd`
 * in each workspace (discarding the agent's eval commits + the seeded test). Only run
 * on repos whose current HEAD is the baseline you want. Runs on the HOST (Argo must be
 * running with the target workspaces ATTACHED, Ollama reachable, password known).
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
// test; `check` (also in the workspace) must exit 0 = task completed. Add graded/
// harder tasks here over time (multi-file features, bug fixes, longer horizons).
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
  // Requires the `bigproj` workspace to be attached (see docs/eval-log.md setup).
  { id: 'bigproj-deps', ws: 'bigproj',
    setup: () => `cp "${path.join(FIXTURES, 'bigproj-dependencies.test.js')}" test/dependencies.test.js`,
    prompt: 'Implement task dependencies in the tasklab project. On TaskService (in src/service.js) add addDependency(taskId, dependsOnId), removeDependency(taskId, dependsOnId), getDependencies(taskId), getDependents(taskId), scheduleOrder(), and readyTasks(). addDependency(X, Y) means "X depends on Y" (Y must be done before X) and stores Y in X.dependsOn via the store. Validate both tasks exist (NotFoundError); reject self-dependencies (ConflictError code SELF_DEPENDENCY), duplicates (DUPLICATE_DEPENDENCY), and edges that would create a cycle (DEPENDENCY_CYCLE). scheduleOrder() returns all task ids in a deterministic topological order (prerequisites first, ties broken by creation order); readyTasks() returns the not-done tasks whose every prerequisite is already done. Read test/dependencies.test.js and src/service.js first, then make the full suite pass with node --test without weakening tests.',
    check: 'npm test' },
];

const authHeaders = { 'content-type': 'application/json', 'x-argo-password': PASSWORD };
const wsPath = (ws) => path.join(WS_ROOT, ws);
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
const shOk = (cmd, cwd) => { try { execSync(cmd, { cwd, stdio: 'pipe' }); return true; } catch { return false; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const baselineOf = (ws) => { try { return sh('git rev-parse HEAD', wsPath(ws)).trim(); } catch { return null; } };
const resetWs = (ws, base) => { if (base) { try { sh(`git reset --hard ${base} && git clean -fd`, wsPath(ws)); } catch (e) { console.error(`reset ${ws}:`, e.message); } } };

async function post(ws, route, body) {
  const r = await fetch(`${URL_BASE}/ws/${ws}/${route}`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`POST /ws/${ws}/${route} → ${r.status} (is the workspace attached? run: argo ${wsPath(ws)})`);
  return r.json().catch(() => ({}));
}
async function waitIdle(ws) {
  const t0 = Date.now();
  await sleep(1500);
  while (Date.now() - t0 < TIMEOUT_S * 1000) {
    let busy = null;
    try { busy = (await (await fetch(`${URL_BASE}/ws/${ws}/status`, { headers: authHeaders })).json()).busy; } catch { /* transient */ }
    if (busy === false) return true;
    await sleep(3000);
  }
  return false;
}

// Scrape per-run behaviour from the newest JSONL log. NOTE: the three intervention
// counters are HEALTHY harness activity, not failures — keep them distinct from a
// true "stall" (a model that narrates and stops, which emits no warning at all and
// shows up as low iters + plan=0 + FAIL). Earlier this file lumped gate+reground
// under a single "stalls" column, which made a *successful* qwen run read as
// "stalls=2"; splitting them keeps the scorecard accurate.
//   gate     — plan/act gate fired (model tried to mutate the project before planning)
//   reground — done-gate nudge fired (verify the objective before finishing)
//   steer    — loop-steer fired (identical call, no new information)
function newestRunMetrics(ws) {
  const dir = path.join(LOGS_DIR, ws);
  let files; try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch { return {}; }
  const f = files[files.length - 1];
  if (!f) return {};
  let meta = {}, plan = 0, iters = 0, gate = 0, reground = 0, steer = 0, errors = 0, maxCtx = 0;
  for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line).event || {}; } catch { continue; }
    if (e.type === '__meta__') meta = e;
    else if (e.type === 'plan') plan++;
    else if (e.type === 'iteration') iters = e.current;
    else if (e.type === 'error') errors++;
    else if (e.type === 'token_usage') maxCtx = Math.max(maxCtx, e.prompt_tokens || 0);
    else if (e.type === 'warning') {
      const msg = e.message || '';
      if (/record a plan|changing the project/i.test(msg)) gate++;
      else if (/re-ground/i.test(msg)) reground++;
      else if (/no new information|STOP —/i.test(msg)) steer++;
    }
  }
  return { status: meta.status, iters, toolCalls: meta.toolCalls, plan, gate, reground, steer, errors, maxCtx };
}

const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };

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
        await post(task.ws, 'chat', { message: task.prompt, model, options: OPTS, maxIterations: MAX_ITER });
        const idle = await waitIdle(task.ws);
        completed = idle && shOk(task.check, wsPath(task.ws));
        m = newestRunMetrics(task.ws);
        if (!idle) m.status = 'TIMEOUT';
      } catch (e) { m = { status: 'ERR', err: e.message }; }
      score.get(model).total++; if (completed) score.get(model).pass++;
      console.log(`${completed ? 'DONE' : 'FAIL'}  ${pad(model, 20)} ${pad(task.id, 18)} status=${pad(m.status, 8)} iters=${pad(m.iters ?? '?', 4)} tools=${pad(m.toolCalls ?? '?', 4)} plan=${m.plan ?? '?'} gate=${m.gate ?? '?'} reg=${m.reground ?? '?'} steer=${m.steer ?? '?'} ctx≈${m.maxCtx ?? '?'}${m.err ? '  ' + m.err : ''}`);
      resetWs(task.ws, baselines[task.ws]);
    }
  }
  console.log('');
}
console.log('=== scorecard (task completion — implemented a function so the suite passes) ===');
for (const model of MODELS) { const s = score.get(model); console.log(`${pad(model, 22)} ${s.pass}/${s.total} completed (${Math.round(100 * s.pass / s.total)}%)`); }

// Ready-to-paste block for docs/eval-log.md — the flywheel's memory.
const date = new Date().toISOString().slice(0, 10);
console.log(`\n--- eval-log entry (paste into docs/eval-log.md) ---`);
console.log(`### ${date} — E2E — harness \`${HARNESS_SHA}${DIRTY}\``);
console.log(`Models: ${MODELS.join(', ')} · ${RUNS} run(s)/task · max_iter ${MAX_ITER} · task completion`);
for (const model of MODELS) { const s = score.get(model); console.log(`- ${model}: ${s.pass}/${s.total} completed (${Math.round(100 * s.pass / s.total)}%)`); }
console.log(`- Notes: <what changed since last run; notable per-task behaviour>`);
