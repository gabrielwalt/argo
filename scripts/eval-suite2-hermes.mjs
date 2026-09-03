#!/usr/bin/env node
/**
 * Hermes Agent baseline driver for the eval-suite2 task set (docs/eval-log.md, 2026-09).
 * Mirrors eval-e2e.mjs's reset -> setup (seed failing test) -> run -> check -> reset
 * pattern, but drives `hermes chat -q` non-interactively instead of Argo's HTTP API,
 * against Hermes's own already-configured `ollama-launch` provider / qwen3.6 model
 * (~/.hermes/config.yaml) — same model, same host, same Ollama instance as Argo's own
 * eval, so the comparison is apples-to-apples on the MODEL; the harnesses differ.
 *
 * Methodological note: Hermes's `terminal.backend` here is `local` (direct host
 * access to the workspace), not Docker-isolated the way Argo's per-workspace
 * containers are. Acceptable for this scratch fixture comparison, but worth stating
 * plainly rather than presenting the two as isolation-equivalent.
 *
 * Usage: node scripts/eval-suite2-hermes.mjs [taskId,taskId,...]
 * Env: EVAL_MAX_TURNS(60) EVAL_TIMEOUT_S(600)
 */
import { execSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const WS = path.join(os.homedir(), 'Sources/test/eval-suite2');
const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'eval-fixtures2');
const MAX_TURNS = Number(process.env.EVAL_MAX_TURNS || 60);
const TIMEOUT_S = Number(process.env.EVAL_TIMEOUT_S || 600);
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);

// Same 8 tasks as scripts/eval-e2e.mjs's eval-suite2 entries — duplicated here
// (not imported) since this is a one-off external-tool comparison, not part of
// Argo's own eval surface.
const TASKS = [
  { id: 'sanity-pool', seed: 'sanity.test.js', check: 'node --test test/sanity.test.js',
    prompt: 'The test suite has a new failing test at test/sanity.test.js for three exported functions in src/sanity.js, all currently unimplemented: hasCloseElements(numbers, threshold) (true iff any two DISTINCT elements differ by strictly less than threshold), fracPart(x) (the fractional part of a non-negative number), and countVowelsY(s) (counts vowels a/e/i/o/u case-insensitively, plus a trailing \'y\'/\'Y\' ONLY when it is the last character). Implement all three so the test passes: node --test test/sanity.test.js.' },
  { id: 'aider-transpose', seed: 'transpose.test.js', check: 'node --test test/transpose.test.js',
    prompt: 'The test suite has a new failing test at test/transpose.test.js expecting an exported function transpose(lines) in src/transpose.js. Given an array of text lines, return the transposed lines: column i of the output is built from character i of every input line, padding a SHORTER line with spaces only up to the point some LATER (lower) line still has a character there — never pad past the true end of the text. Read the test cases carefully (the padding/trimming edge cases are the actual difficulty here), then implement it so the full test passes: node --test test/transpose.test.js.' },
  { id: 'exercism-circular-buffer', seed: 'circular-buffer.test.js', check: 'node --test test/circular-buffer.test.js',
    prompt: 'The test suite has a new failing test at test/circular-buffer.test.js expecting a CircularBuffer class (plus BufferFullError/BufferEmptyError) in src/circular-buffer.js, all currently unimplemented. A fixed-capacity FIFO buffer: write(item) throws BufferFullError when full, read() throws BufferEmptyError when empty and otherwise returns+removes the oldest item, overwrite(item) evicts the oldest item instead of throwing when full, clear() empties it without changing capacity. Implement it so the full test passes: node --test test/circular-buffer.test.js.' },
  { id: 'quixbugs-kth', seed: 'kth.test.js', check: 'node --test test/kth.test.js',
    prompt: 'The test suite has a new failing test at test/kth.test.js for kth(arr, k) in src/kth.js — a QuickSelect implementation meant to be equivalent to sorted(arr)[k] (0-based). It currently returns the wrong element for many inputs. Read the test and the implementation, find the root cause, and fix it so the full test passes: node --test test/kth.test.js.' },
  { id: 'quixbugs-knapsack', seed: 'knapsack.test.js', check: 'node --test test/knapsack.test.js',
    prompt: 'The test suite has a new failing test at test/knapsack.test.js for knapsack(capacity, items) in src/knapsack.js — a 0/1 knapsack DP implementation that returns the wrong (too-low) answer for some inputs. Read the test and the implementation, find the root cause (a boundary condition), and fix it so the full test passes: node --test test/knapsack.test.js.' },
  { id: 'swe-style-eventbus', seed: 'event-bus.test.js', check: 'node --test test/event-bus.test.js',
    prompt: 'The test suite has a new failing test at test/event-bus.test.js for the EventBus class in src/event-bus.js: off(event, handler) is supposed to remove only that ONE handler, but currently removes every handler registered for the event. Read the test and the implementation, find the bug, and fix it so the full test passes: node --test test/event-bus.test.js.' },
  { id: 'swe-style-pagination', seed: 'pagination.test.js', check: 'node --test test/pagination.test.js',
    prompt: 'The test suite has a new failing test at test/pagination.test.js for paginate(items, pageSize, pageNumber) in src/pagination.js: it\'s supposed to return 1-based page `pageNumber`, but the slice bounds are wrong (every page returns the PREVIOUS page\'s items, and the last page can come back empty). Read the test and the implementation, find the bug, and fix it so the full test passes: node --test test/pagination.test.js.' },
  { id: 'race-semaphore', seed: 'semaphore.test.js', check: 'node --test test/semaphore.test.js',
    prompt: 'The test suite has a new failing test at test/semaphore.test.js for runWithLimit(tasks, limit) / the Semaphore class in src/semaphore.js, meant to run at most `limit` async tasks concurrently. It currently allows MORE than `limit` tasks to run at once due to a race condition in acquire() (a check-then-act race across an await boundary — a classic time-of-check-to-time-of-use bug, not a timing/flakiness issue). Read the test and the implementation, find the race, and fix it so the full test passes: node --test test/semaphore.test.js.' },

  // Floor/ceiling additions — same fixtures as eval-e2e.mjs's matching entries.
  // No seed file: pure Q&A, checked against Hermes's own printed output text instead
  // of a workspace file (checkText, not check).
  { id: 'trivial-qa-arithmetic',
    prompt: 'What is 17 multiplied by 24? Reply with just the resulting number — nothing in this project needs to change for this question.',
    checkText: (raw) => /\b408\b/.test(raw) },
  { id: 'trivial-fix-greeting-typo', seed: 'greeting.test.js', check: 'node --test test/greeting.test.js',
    prompt: 'There\'s a typo in src/greeting.js\'s greeting string — it says "Helo" instead of "Hello". Fix that one word so the test suite passes: node --test test/greeting.test.js.' },
  { id: 'large-task-queue', seed: 'task-queue.test.js', check: 'node --test test/task-queue.test.js',
    prompt: 'The test suite has a new failing test at test/task-queue.test.js expecting a TaskQueue class in src/task-queue.js (it currently just throws \'not implemented\'). Build an in-memory async task queue: `new TaskQueue({ concurrency, maxRetries })`; `add(fn, { priority = 0 })` queues an async fn and returns a promise that resolves/rejects with its eventual outcome; at most `concurrency` tasks run at once; among tasks currently waiting to start, higher `priority` runs first (equal priority keeps insertion order); a task whose fn rejects is retried up to `maxRetries` additional times before add()\'s returned promise rejects with the LAST error; `drain()` returns a promise that resolves once every queued task — including any still-retrying ones — has finished. Read the test carefully for the exact semantics, implement it, and make the full test pass: node --test test/task-queue.test.js.' },
];

const sh = (cmd) => execSync(cmd, { cwd: WS, stdio: 'pipe' }).toString();
const shOk = (cmd) => { try { execSync(cmd, { cwd: WS, stdio: 'pipe' }); return true; } catch { return false; } };
const baseline = sh('git rev-parse HEAD').trim();
const reset = () => { try { sh(`git reset --hard ${baseline} && git clean -fd`); } catch (e) { console.error('reset failed:', e.message); } };

const results = [];
for (const task of TASKS) {
  if (ONLY.length && !ONLY.includes(task.id)) continue;
  reset();
  if (task.seed) sh(`cp "${path.join(FIXTURES, task.seed)}" test/${task.seed}`);

  const t0 = Date.now();
  let raw = '', err = null;
  try {
    raw = execFileSync(
      'hermes',
      ['chat', '-q', task.prompt, '-m', 'qwen3.6', '--provider', 'ollama-launch', '-Q', '--yolo', '--ignore-rules', '--max-turns', String(MAX_TURNS)],
      { cwd: WS, stdio: 'pipe', timeout: TIMEOUT_S * 1000, maxBuffer: 32 * 1024 * 1024 },
    ).toString();
  } catch (e) {
    err = e.message;
    raw = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
  }
  const wallMs = Date.now() - t0;
  const completed = !err && (task.checkText ? task.checkText(raw) : shOk(task.check));
  results.push({ id: task.id, completed, wallMs, err, tail: raw.slice(-800) });
  console.log(`${completed ? 'DONE' : 'FAIL'}  ${task.id.padEnd(26)} wall=${Math.round(wallMs / 1000)}s${err ? '  ERR: ' + err.split('\n')[0] : ''}`);
  reset();
}

const pass = results.filter(r => r.completed).length;
console.log(`\n=== Hermes (qwen3.6 via ollama-launch) — ${pass}/${results.length} completed ===`);
for (const r of results) {
  if (!r.completed) console.log(`\n--- ${r.id} tail ---\n${r.tail}`);
}
