#!/usr/bin/env node
/**
 * Small trend framework over history.jsonl (written by both e2e.mjs and hermes.mjs) —
 * turns "has this task always been this variable?" and "how does Argo's speed compare
 * to Hermes on this exact task?" from a manual grep-and-read exercise (how
 * bigproj-duedate-bug's and bigproj-effort's historical ranges were pieced together
 * before this existed) into a mechanical one. Complements docs/eval-log.md's
 * qualitative narrative; doesn't replace it — this is numbers only, no analysis.
 *
 * Usage: node scripts/eval/trend.mjs [taskId,taskId,...]
 * Env: EVAL_HISTORY_FILE (default ~/.local/share/argo/eval-runs/history.jsonl)
 *      EVAL_VARIANCE_RATIO (default 2 — flag a task if max/min wall or iters exceeds this)
 *      EVAL_SPEED_TARGET (default 1.5 — Argo:Hermes wall-clock ratio target, flagged if exceeded)
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HISTORY_FILE = process.env.EVAL_HISTORY_FILE || path.join(os.homedir(), '.local/share/argo/eval-runs/history.jsonl');
const VARIANCE_RATIO = Number(process.env.EVAL_VARIANCE_RATIO || 2);
const SPEED_TARGET = Number(process.env.EVAL_SPEED_TARGET || 1.5);
const ONLY = (process.argv[2] || '').split(',').map(s => s.trim()).filter(Boolean);

if (!existsSync(HISTORY_FILE)) {
  console.error(`No history file at ${HISTORY_FILE} yet — run scripts/eval/e2e.mjs or hermes.mjs at least once first.`);
  process.exit(1);
}

const rows = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const byTask = new Map();
for (const r of rows) {
  if (ONLY.length && !ONLY.includes(r.taskId)) continue;
  if (!byTask.has(r.taskId)) byTask.set(r.taskId, []);
  byTask.get(r.taskId).push(r);
}

const stat = (nums) => {
  const v = nums.filter(n => n != null);
  if (v.length === 0) return { min: null, mean: null, max: null };
  return { min: Math.min(...v), mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length), max: Math.max(...v) };
};
const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
const last = (arr) => arr.length ? arr[arr.length - 1] : null;

console.log(`Trend over ${rows.length} recorded run(s), ${byTask.size} task(s) — ${HISTORY_FILE}\n`);
console.log(pad('task', 28) + pad('harness', 8) + pad('n', 4) + pad('pass', 6) + pad('score', 7) + pad('wall min/mean/max', 20) + 'flag');

for (const [taskId, allRuns] of [...byTask.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const byHarness = new Map();
  for (const r of allRuns) {
    const h = r.harness || 'argo'; // pre-harness-field history rows default to argo
    if (!byHarness.has(h)) byHarness.set(h, []);
    byHarness.get(h).push(r);
  }
  for (const [harness, runs] of byHarness.entries()) {
    const passRate = `${runs.filter(r => r.completed).length}/${runs.length}`;
    const wall = stat(runs.map(r => r.wallMs != null ? Math.round(r.wallMs / 1000) : null));
    const scoreStat = stat(runs.map(r => r.score));
    const flags = [];
    if (wall.min != null && wall.min > 0 && wall.max / wall.min >= VARIANCE_RATIO) flags.push(`wall ${(wall.max / wall.min).toFixed(1)}x`);
    if (passRate !== `${runs.length}/${runs.length}`) flags.push('FAILS SEEN');
    console.log(
      pad(taskId, 28) + pad(harness, 8) + pad(runs.length, 4) + pad(passRate, 6)
      + pad(scoreStat.mean != null ? `${scoreStat.mean}` : '?', 7)
      + pad(`${wall.min}/${wall.mean}/${wall.max}`, 20)
      + (flags.length ? flags.join(', ') : ''),
    );
  }
  // Speed ratio: most recent Argo wall vs most recent Hermes wall on this task. The
  // whole point of the eval-strategy rework (docs/roadmap.md, 2026-09-03) — Argo's
  // own rubricScore already penalizes this per-run; this is the same comparison,
  // surfaced in aggregate.
  const argoRuns = byHarness.get('argo'), hermesRuns = byHarness.get('hermes');
  if (argoRuns && hermesRuns) {
    const argoWall = last(argoRuns)?.wallMs, hermesWall = last(hermesRuns)?.wallMs;
    if (argoWall && hermesWall) {
      const ratio = argoWall / hermesWall;
      const verdict = ratio <= SPEED_TARGET ? 'OK' : 'OVER TARGET';
      console.log(pad('', 28) + pad('', 8) + `speed ratio (argo/hermes): ${ratio.toFixed(2)}x (target <= ${SPEED_TARGET}x) — ${verdict}`);
    }
  }
}
