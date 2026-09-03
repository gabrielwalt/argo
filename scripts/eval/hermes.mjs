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
 * Usage: node scripts/eval/hermes.mjs [taskId,taskId,...]
 *   EVAL_TASKS="bigproj-deps,bigproj-effort" node scripts/eval/hermes.mjs
 * Env: EVAL_MAX_TURNS(60) EVAL_TIMEOUT_S(1800)
 */
import { execFileSync } from 'node:child_process';
import {
  TASKS, REPO, wsPath, sh, shOk, baselineOf, resetWs, shScore, testFileTampered, rubricScore, appendHistory,
} from './tasks.mjs';

const MAX_TURNS = Number(process.env.EVAL_MAX_TURNS || 60);
const TIMEOUT_S = Number(process.env.EVAL_TIMEOUT_S || 1800);
const ONLY = (process.env.EVAL_TASKS || process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);
const HARNESS_SHA = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, stdio: 'pipe' }).toString().trim(); } catch { return 'nogit'; } })();

const baselines = Object.fromEntries([...new Set(TASKS.map(t => t.ws))].map(ws => [ws, baselineOf(ws)]));

const results = [];
for (const task of TASKS) {
  if (ONLY.length && !ONLY.includes(task.id)) continue;
  const ws = wsPath(task.ws);
  resetWs(task.ws, baselines[task.ws]);
  if (task.setup) sh(task.setup(ws), ws);

  const t0 = Date.now();
  let raw = '', err = null;
  try {
    raw = execFileSync(
      'hermes',
      ['chat', '-q', task.prompt, '-m', 'qwen3.6', '--provider', 'ollama-launch', '-Q', '--yolo', '--ignore-rules', '--max-turns', String(MAX_TURNS)],
      { cwd: ws, stdio: 'pipe', timeout: TIMEOUT_S * 1000, maxBuffer: 32 * 1024 * 1024 },
    ).toString();
  } catch (e) {
    err = e.message;
    raw = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
  }
  const wallMs = Date.now() - t0;
  // `check` is either a shell command (run in the workspace) or a function (m =>
  // boolean) for file-less tasks — fed { finalAnswer: raw } so it can match against
  // Hermes's own printed transcript the same way e2e.mjs matches the run's final answer.
  // Run the string-check ONCE via shScore (captures test-runner output for the rubric's
  // test-fraction, same reasoning as e2e.mjs) rather than shOk-then-reparse separately.
  let testResult = null, completed;
  if (typeof task.check === 'function') {
    completed = !err && task.check({ finalAnswer: raw });
  } else {
    testResult = shScore(task.check, ws);
    completed = !err && testResult.fraction === 1;
  }
  const tampered = testFileTampered(task.ws, task.testFile);
  // No referenceWallMs lookup here: Hermes IS this framework's speed reference (see
  // docs/roadmap.md's eval-strategy entry — the target is "Argo <= 1.5x Hermes," not
  // the reverse), so Hermes's own speed dimension always scores full marks.
  const rubric = rubricScore({ testResult, tampered, wallMs, referenceWallMs: null });
  results.push({ id: task.id, completed, wallMs, err, score: rubric.total, tail: raw.slice(-1200) });
  console.log(`${completed ? 'DONE' : 'FAIL'}  ${task.id.padEnd(26)} score=${String(rubric.total).padStart(3)} wall=${Math.round(wallMs / 1000)}s${err ? '  ERR: ' + err.split('\n')[0] : ''}`);
  appendHistory({
    ts: new Date().toISOString(), harness: 'hermes', harnessSha: HARNESS_SHA, model: 'qwen3.6', taskId: task.id, ws: task.ws,
    completed, score: rubric.total, scoreBreakdown: rubric, status: completed ? 'done' : (err ? 'ERR' : 'FAIL'),
    wallMs, err: err ?? null,
  });
  resetWs(task.ws, baselines[task.ws]);
}

const pass = results.filter(r => r.completed).length;
const avgScore = results.length ? Math.round(results.reduce((a, r) => a + r.score, 0) / results.length) : 0;
console.log(`\n=== Hermes (qwen3.6 via ollama-launch) — ${pass}/${results.length} completed · avg score ${avgScore}/100 ===`);
for (const r of results) {
  if (!r.completed) console.log(`\n--- ${r.id} tail ---\n${r.tail}`);
}
