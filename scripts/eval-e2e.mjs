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
import { readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
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
// Multi-agent's per-workspace ledger (.argo/ledger.jsonl — delegation/conclusion/
// standup/injection entries, the authoritative record of WHICH frames ran and what
// verdicts the Boss returned) lives INSIDE the workspace and is gitignored, so the
// very next resetWs() (`git clean -fd`) deletes it before it can be inspected. Saved
// out here, per task/run, so a later qualitative pass over orchestration behavior
// (which frames spawned, in what order, what the Boss decided) has something to
// read — the JSONL logs alone can't answer "did the Boss escalate," only the ledger
// records that.
const LEDGER_OUT_DIR = process.env.EVAL_LEDGER_DIR || path.join(os.homedir(), '.local/share/argo/eval-ledgers');
function saveLedger(ws, taskId) {
  const src = path.join(wsPath(ws), '.argo', 'ledger.jsonl');
  if (!existsSync(src)) return;
  mkdirSync(LEDGER_OUT_DIR, { recursive: true });
  try { copyFileSync(src, path.join(LEDGER_OUT_DIR, `${taskId}.jsonl`)); } catch { /* best-effort */ }
}
// Same problem as the ledger above, for the actual CODE change: resetWs()'s `git
// reset --hard` wipes it before a later quality-judge pass (scripts/eval-quality-
// judge.mjs) could read it. Saved as a plain unified diff, not committed anywhere.
const DIFF_OUT_DIR = process.env.EVAL_DIFF_DIR || path.join(os.homedir(), '.local/share/argo/eval-diffs');
// Diffs against the task's own BASELINE ref (the same one resetWs() restores to), NOT
// bare `HEAD` — autoCommit() (src/agent.ts) may have committed the agent's own work
// during the run, moving HEAD forward to include it, which would make `git diff HEAD`
// show almost nothing (a real bug hit once: it made a complete, test-passing
// implementation look like it had "only added an unrelated remove() method" to the
// quality judge, which correctly flagged drift/hallucination given that bad input —
// the judge wasn't wrong, the diff it was fed was).
function saveDiff(ws, taskId, baseline) {
  mkdirSync(DIFF_OUT_DIR, { recursive: true });
  try {
    const diff = sh(`git diff ${baseline}`, wsPath(ws));
    writeFileSync(path.join(DIFF_OUT_DIR, `${taskId}.diff`), diff);
  } catch { /* best-effort — an empty/failed diff just means no quality judging for this task */ }
}
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

  // ─────────────────────────────────────────────────────────────────────────
  // eval-suite2 (docs/eval-log.md, 2026-09): 8 tasks added to give the eval
  // headroom beyond tasklab/test-one and to carry an EXTERNAL comparison point —
  // see the entries' own notes for exactly which are real ported benchmark
  // programs (verified against their own published test cases) vs. custom-
  // authored (clearly noted where so). Each check is scoped to just that task's
  // own seeded test file — eval-suite2 holds all 8 side by side, so a shared
  // `npm test` would run whichever OTHER tasks' tests happen to be seeded too.
  // ─────────────────────────────────────────────────────────────────────────

  // Tier 0 sanity pool — inspired by HumanEval's shape (one clear function, a few
  // edge cases), self-authored (not literal HumanEval problems, to keep the
  // reference spec unambiguous). Cheap; meant to run every cycle as a harness
  // health check before the harder tasks below.
  { id: 'sanity-pool', ws: 'eval-suite2',
    setup: () => `cp "${path.join(FIXTURES, '..', 'eval-fixtures2', 'sanity.test.js')}" test/sanity.test.js`,
    prompt: 'The test suite has a new failing test at test/sanity.test.js for three exported functions in src/sanity.js, all currently unimplemented: hasCloseElements(numbers, threshold) (true iff any two DISTINCT elements differ by strictly less than threshold), fracPart(x) (the fractional part of a non-negative number), and countVowelsY(s) (counts vowels a/e/i/o/u case-insensitively, plus a trailing \'y\'/\'Y\' ONLY when it is the last character). Implement all three so the test passes: node --test test/sanity.test.js.',
    check: 'node --test test/sanity.test.js' },

  // Tier 4 (Aider-polyglot hard tier) — the REAL Exercism "Transpose" exercise
  // (exercism/javascript, MIT). Test file generated directly from the canonical
  // problem-specifications data (12 cases) — not hand-transcribed.
  { id: 'aider-transpose', ws: 'eval-suite2',
    setup: () => `cp "${path.join(FIXTURES, '..', 'eval-fixtures2', 'transpose.test.js')}" test/transpose.test.js`,
    prompt: 'The test suite has a new failing test at test/transpose.test.js expecting an exported function transpose(lines) in src/transpose.js. Given an array of text lines, return the transposed lines: column i of the output is built from character i of every input line, padding a SHORTER line with spaces only up to the point some LATER (lower) line still has a character there — never pad past the true end of the text. Read the test cases carefully (the padding/trimming edge cases are the actual difficulty here), then implement it so the full test passes: node --test test/transpose.test.js.',
    check: 'node --test test/transpose.test.js' },

  // Tier 2 (Exercism medium, multi-method) — the REAL Exercism "Circular Buffer"
  // exercise. Test file generated from the canonical problem-specifications
  // operations-sequence data (14 cases, incl. wraparound/overwrite edge cases).
  { id: 'exercism-circular-buffer', ws: 'eval-suite2',
    setup: () => `cp "${path.join(FIXTURES, '..', 'eval-fixtures2', 'circular-buffer.test.js')}" test/circular-buffer.test.js`,
    prompt: 'The test suite has a new failing test at test/circular-buffer.test.js expecting a CircularBuffer class (plus BufferFullError/BufferEmptyError) in src/circular-buffer.js, all currently unimplemented. A fixed-capacity FIFO buffer: write(item) throws BufferFullError when full, read() throws BufferEmptyError when empty and otherwise returns+removes the oldest item, overwrite(item) evicts the oldest item instead of throwing when full, clear() empties it without changing capacity. Implement it so the full test passes: node --test test/circular-buffer.test.js.',
    check: 'node --test test/circular-buffer.test.js' },

  // Tier 1 (easy debug) — REAL QuixBugs bug (jkoppel/QuixBugs, python_programs/
  // kth.py), ported to JS. Test cases are QuixBugs' own json_testcases/kth.json,
  // not invented.
  { id: 'quixbugs-kth', ws: 'eval-suite2',
    setup: () => `cp "${path.join(FIXTURES, '..', 'eval-fixtures2', 'kth.test.js')}" test/kth.test.js`,
    prompt: 'The test suite has a new failing test at test/kth.test.js for kth(arr, k) in src/kth.js — a QuickSelect implementation meant to be equivalent to sorted(arr)[k] (0-based). It currently returns the wrong element for many inputs. Read the test and the implementation, find the root cause, and fix it so the full test passes: node --test test/kth.test.js.',
    check: 'node --test test/kth.test.js' },

  // Tier 3 (harder debug, multi-step DP) — REAL QuixBugs bug (python_programs/
  // knapsack.py), ported to JS. Test cases are QuixBugs' own json_testcases/
  // knapsack.json.
  { id: 'quixbugs-knapsack', ws: 'eval-suite2',
    setup: () => `cp "${path.join(FIXTURES, '..', 'eval-fixtures2', 'knapsack.test.js')}" test/knapsack.test.js`,
    prompt: 'The test suite has a new failing test at test/knapsack.test.js for knapsack(capacity, items) in src/knapsack.js — a 0/1 knapsack DP implementation that returns the wrong (too-low) answer for some inputs. Read the test and the implementation, find the root cause (a boundary condition), and fix it so the full test passes: node --test test/knapsack.test.js.',
    check: 'node --test test/knapsack.test.js' },

  // Tier 2/3 (SWE-bench-style real-world bug) — CUSTOM-AUTHORED, styled after a
  // realistic small bug-fix issue (no live SWE-bench/Multi-SWE-bench dataset pull
  // — that needs network access to HuggingFace/GitHub beyond this eval's scope;
  // flagged honestly rather than mislabeled as a literal benchmark instance).
  { id: 'swe-style-eventbus', ws: 'eval-suite2',
    setup: () => `cp "${path.join(FIXTURES, '..', 'eval-fixtures2', 'event-bus.test.js')}" test/event-bus.test.js`,
    prompt: 'The test suite has a new failing test at test/event-bus.test.js for the EventBus class in src/event-bus.js: off(event, handler) is supposed to remove only that ONE handler, but currently removes every handler registered for the event. Read the test and the implementation, find the bug, and fix it so the full test passes: node --test test/event-bus.test.js.',
    check: 'node --test test/event-bus.test.js' },

  // Tier 2/3 (SWE-bench-style real-world bug, easier decile) — CUSTOM-AUTHORED,
  // same honesty note as swe-style-eventbus above.
  { id: 'swe-style-pagination', ws: 'eval-suite2',
    setup: () => `cp "${path.join(FIXTURES, '..', 'eval-fixtures2', 'pagination.test.js')}" test/pagination.test.js`,
    prompt: 'The test suite has a new failing test at test/pagination.test.js for paginate(items, pageSize, pageNumber) in src/pagination.js: it\'s supposed to return 1-based page `pageNumber`, but the slice bounds are wrong (every page returns the PREVIOUS page\'s items, and the last page can come back empty). Read the test and the implementation, find the bug, and fix it so the full test passes: node --test test/pagination.test.js.',
    check: 'node --test test/pagination.test.js' },

  // Tier 3 (custom race condition — flagged in research as a genuine gap: no
  // public JS-concurrency-bug benchmark was found, so this one has to be
  // hand-built). A real async time-of-check-to-time-of-use race, not a timing-
  // sensitive flaky check — the test asserts a concurrency-limit INVARIANT.
  { id: 'race-semaphore', ws: 'eval-suite2',
    setup: () => `cp "${path.join(FIXTURES, '..', 'eval-fixtures2', 'semaphore.test.js')}" test/semaphore.test.js`,
    prompt: 'The test suite has a new failing test at test/semaphore.test.js for runWithLimit(tasks, limit) / the Semaphore class in src/semaphore.js, meant to run at most `limit` async tasks concurrently. It currently allows MORE than `limit` tasks to run at once due to a race condition in acquire() (a check-then-act race across an await boundary — a classic time-of-check-to-time-of-use bug, not a timing/flakiness issue). Read the test and the implementation, find the race, and fix it so the full test passes: node --test test/semaphore.test.js.',
    check: 'node --test test/semaphore.test.js' },

  // ── FLOOR (below the tier-0 sanity pool) — the multi-agent harness's own
  // skippable-phase mechanism (docs/subagents-plan.md, "Boss 3-way task-start
  // router") should collapse to near-zero ceremony for these two. No prior tier here
  // took fewer than ~11-20 iterations even at its cheapest — these exist specifically
  // to see whether ANSWER/TRIVIAL classification actually fires, or whether the Boss
  // defaults to the full OBJECTIVE pipeline regardless.
  //
  // Pure Q&A, no project relevance at all — the ideal case for the Boss's ANSWER
  // mode: classify-and-answer immediately, no Planner/Implementer/Tester frame ever
  // spawned. Verified against the run's own final answer text (there is no file to
  // check — nothing should change on disk at all).
  { id: 'trivial-qa-arithmetic', ws: 'eval-suite2',
    prompt: 'What is 17 multiplied by 24? Reply with just the resulting number — nothing in this project needs to change for this question.',
    check: (m) => /\b408\b/.test(m.finalAnswer || '') },

  // A single, unambiguous one-word fix — the ideal case for the Boss's TRIVIAL mode:
  // skip the Planner and Tester, one Implementer frame, done.
  { id: 'trivial-fix-greeting-typo', ws: 'eval-suite2',
    setup: () => `cp "${path.join(FIXTURES, '..', 'eval-fixtures2', 'greeting.test.js')}" test/greeting.test.js`,
    prompt: 'There\'s a typo in src/greeting.js\'s greeting string — it says "Helo" instead of "Hello". Fix that one word so the test suite passes: node --test test/greeting.test.js.',
    check: 'node --test test/greeting.test.js' },

  // ── CEILING (above every prior tier) — CUSTOM-AUTHORED (self-consistency verified
  // against a real reference implementation before seeding — see scripts/eval-
  // fixtures2/task-queue.test.js's own history). Multiple interacting concerns
  // (priority ordering, bounded concurrency, retry-with-backoff, drain semantics) in
  // ONE module — meaningfully bigger than every other task here, and exactly the
  // shape (many interacting pieces, no single obvious fix) where a single
  // Implementer frame risks running past LARGE_FRAME_ITERATIONS (dispatch.ts) and
  // Planner decomposition could plausibly help, if it helps at all — that is
  // precisely the open question this task exists to give real evidence on.
  { id: 'large-task-queue', ws: 'eval-suite2',
    setup: () => `cp "${path.join(FIXTURES, '..', 'eval-fixtures2', 'task-queue.test.js')}" test/task-queue.test.js`,
    prompt: 'The test suite has a new failing test at test/task-queue.test.js expecting a TaskQueue class in src/task-queue.js (it currently just throws \'not implemented\'). Build an in-memory async task queue: `new TaskQueue({ concurrency, maxRetries })`; `add(fn, { priority = 0 })` queues an async fn and returns a promise that resolves/rejects with its eventual outcome; at most `concurrency` tasks run at once; among tasks currently waiting to start, higher `priority` runs first (equal priority keeps insertion order); a task whose fn rejects is retried up to `maxRetries` additional times before add()\'s returned promise rejects with the LAST error; `drain()` returns a promise that resolves once every queued task — including any still-retrying ones — has finished. Read the test carefully for the exact semantics, implement it, and make the full test pass: node --test test/task-queue.test.js.',
    check: 'node --test test/task-queue.test.js' },
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

// Scrape per-run quality + cost from ALL JSONL logs touched during this run, not just
// "the newest file" — under the multi-agent harness (config.agents), ONE /chat call
// produces MULTIPLE log files: the dispatch's own top-level narrative (start/
// objective/task_graph/boss_verdict/replan/message/done) PLUS one separate file per
// spawned frame (Planner/Implementer/Tester/Boss each get their own real Agent.chat()
// log). Taking only the alphabetically-last file silently picked up whichever frame
// happened to write last (often a short Boss check, e.g. "it=2") and completely
// missed the real Implementer/Planner work — a baseline-era assumption ("one /chat
// call, one log file") that no longer holds. Aggregates by taking every .jsonl file
// whose mtime falls at/after this run's start (sinceMs, with a small negative buffer
// for clock skew between Date.now() here and the file write).
//   gate     — plan/act gate fired (tried to mutate the project before planning)
//   reground — done-gate nudge fired (verify the objective before finishing)
//   steer    — loop-steer fired (identical call, no new information)
//   cmp      — compactions over the run
//   frames   — how many separate Agent.chat() logs this run produced (1 under the
//              baseline single-loop path; >1 whenever the multi-agent harness spawned
//              a Planner/Implementer/Tester/Boss frame)
//   tok/s    — generation throughput; needs the harness to log Ollama eval_duration
//              (token_usage.eval_duration_ms). "?" until that lands — see roadmap Phase 3(b).
const FRAME_SESSION_ID = /^(planner|implementer|tester|boss)-/;
function runMetrics(ws, sinceMs) {
  const dir = path.join(LOGS_DIR, ws);
  let files; try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return {}; }
  const inWindow = files.filter(f => { try { return statSync(path.join(dir, f)).mtimeMs >= sinceMs - 2000; } catch { return false; } });
  let plan = 0, iters = 0, toolCalls = 0, gate = 0, reground = 0, steer = 0, errors = 0, frames = 0;
  let maxCtx = 0, compactions = 0, genTokens = 0, genMs = 0, topStatus, finalAnswer = '';
  for (const f of inWindow) {
    let meta = {}, fileIters = 0;
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) {
      let e; try { e = JSON.parse(line).event || {}; } catch { continue; }
      if (e.type === '__meta__') meta = e;
      else if (e.type === 'plan') plan++;
      else if (e.type === 'iteration') fileIters = e.current;
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
      } else if (e.type === 'done' && !FRAME_SESSION_ID.test(meta.sessionId || '')) {
        finalAnswer = e.content || finalAnswer; // only the TOP-LEVEL run's own answer, never a frame's
      }
    }
    frames++;
    iters += fileIters; // SUM across frames — total LLM-call volume, not any one frame's own count
    toolCalls += meta.toolCalls || 0;
    if (!FRAME_SESSION_ID.test(meta.sessionId || '')) topStatus = meta.status; // the dispatch's own status, not a frame's
  }
  const tokPerSec = genMs > 0 ? Math.round(genTokens / (genMs / 1000)) : null;
  return { status: topStatus, iters, toolCalls, plan, gate, reground, steer, maxCtx, compactions, tokPerSec, errors, frames, finalAnswer };
}

const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
const secs = (ms) => ms != null ? `${Math.round(ms / 1000)}s` : '?';

console.log(`Argo E2E eval — harness ${HARNESS_SHA}${DIRTY} — ${MODELS.length} model(s) × ${TASKS.length} task(s) × ${RUNS} run(s) — ${URL_BASE}\n`);
const baselines = Object.fromEntries([...new Set(TASKS.map(t => t.ws))].map(ws => [ws, baselineOf(ws)]));
const score = new Map(MODELS.map(m => [m, { pass: 0, total: 0 }]));

for (const model of MODELS) {
  for (const task of TASKS.filter(t => { const o = (process.env.EVAL_TASKS || '').split(',').map(s => s.trim()).filter(Boolean); return o.length === 0 || o.includes(t.id) })) {
    for (let i = 0; i < RUNS; i++) {
      resetWs(task.ws, baselines[task.ws]);
      let completed = false, m = {};
      try {
        if (task.setup) sh(task.setup(wsPath(task.ws)), wsPath(task.ws));  // seed the failing test
        await post(task.ws, 'reset', {});
        const tRun = Date.now();
        const HARNESS = ['1', 'true', 'on', 'yes'].includes((process.env.EVAL_HARNESS || '').trim().toLowerCase());
        await post(task.ws, 'chat', { message: task.prompt, model, options: OPTS, maxIterations: MAX_ITER, ...(HARNESS ? { tasks: true, memory: true, loop: true } : {}) });
        const w = await waitIdle(task.ws);
        const wallMs = Date.now() - tRun;
        m = runMetrics(task.ws, tRun);
        // check may be a shell command (string, run in the workspace) or a function
        // (m => boolean) for tasks with no file-based signal to check — e.g. a pure
        // Q&A task that should trigger the Boss's ANSWER mode and never touch the
        // workspace at all, verified against the run's own final answer text instead.
        completed = w.idle && (typeof task.check === 'function' ? task.check(m) : shOk(task.check, wsPath(task.ws)));
        if (!w.idle) {
          m.status = 'TIMEOUT';
          // A timed-out run is NOT actually stopped server-side — waitIdle just gave
          // up polling. Without this, the run keeps consuming the GPU in the
          // background and every subsequent task's own `reset` 409s ("Agent is busy")
          // for as long as the timed-out run happens to keep going — a real failure
          // mode hit in practice (one 30-min timeout cascaded into 3 more FAILs).
          try { await post(task.ws, 'stop', {}); } catch { /* best-effort */ }
          await sleep(2000);
        }
        m.wallMs = wallMs; m.peakRssMb = w.peakRssMb; m.procSplit = w.procSplit; m.sizeStr = w.sizeStr;
      } catch (e) { m = { status: 'ERR', err: e.message }; }
      score.get(model).total++; if (completed) score.get(model).pass++;
      console.log(
        `${completed ? 'DONE' : 'FAIL'}  ${pad(model, 18)} ${pad(task.id, 16)} ${pad(m.status ?? '?', 8)}`
        + ` it=${pad(m.iters ?? '?', 3)} tool=${pad(m.toolCalls ?? '?', 3)} frames=${pad(m.frames ?? '?', 2)} plan=${m.plan ?? '?'} g=${m.gate ?? '?'} r=${m.reground ?? '?'} s=${m.steer ?? '?'} cmp=${m.compactions ?? '?'}`
        + ` | wall=${pad(secs(m.wallMs), 5)} tok/s=${pad(m.tokPerSec ?? '?', 4)} ctx≈${pad(m.maxCtx ?? '?', 6)} rss=${pad((m.peakRssMb ? m.peakRssMb + 'MB' : '?'), 7)} ${m.procSplit ?? ''}`
        + `${m.err ? '  ' + m.err : ''}`,
      );
      saveLedger(task.ws, task.id);
      saveDiff(task.ws, task.id, baselines[task.ws]);
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
