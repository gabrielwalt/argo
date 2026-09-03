#!/usr/bin/env node
/**
 * Small trend framework over history.jsonl (written by both e2e.mjs and hermes.mjs) —
 * turns "has this task always been this variable?" and "how does Argo's speed compare
 * to Hermes on this exact task?" from a manual grep-and-read exercise (how
 * bigproj-duedate-bug's and bigproj-effort's historical ranges were pieced together
 * before this existed) into a mechanical one. Complements docs/eval-log.md's
 * qualitative narrative; doesn't replace it — this is numbers only, no analysis.
 *
 * BATCH 1 changes, all of them corrections to things this tool got WRONG:
 *
 *  1. IT REFUSES TO COMPARE ACROSS RUBRIC VERSIONS. Rubric v1 was 70 correctness (whole-
 *     suite fraction) + 15 integrity + 15 speed; v2 is 60 targeted correctness + 20
 *     quality + 20 reliability behind two binary gates, with speed removed. Averaging
 *     them produces a line that looks continuous across a scoring change, which is a
 *     lie. Scores are reported per version, side by side, never pooled. Old rows keep
 *     their old score and are NOT retro-fitted.
 *  2. `harness` is no longer defaulted to 'argo'. 17 of the first 33 rows had
 *     harness:null (they are backfilled historical rows), and silently calling them
 *     'argo' invented attribution for over half the ledger. They are reported as
 *     `unattrib` and excluded from any cross-harness comparison.
 *  3. Rows marked `invalid:true` are skipped, with a count printed. Four rows at
 *     2026-09-03T11:35:25 are fabricated failures — `POST /reset → 409` after a
 *     detach/reattach, recorded as four real task failures at score 0 — which is why
 *     this tool has reported bigproj-deps as 0/1 pass with mean score 0 since day one.
 *     Run `node scripts/eval/quarantine-history.mjs --write` to mark them.
 *  4. Split by `agents`, so multi-agent runs, the four accidental single-loop runs and
 *     the backfilled rows are no longer pooled under one label — the architecture
 *     comparison this tool was built for was invisible.
 *  5. The v2 composite score is a BATCH quantity (reliability is a pass rate over the k
 *     runs in a batch), so per-task v2 scores are aggregated per `batchId`; a row's own
 *     `score` is null by construction under v2.
 *
 * Usage: node scripts/eval/trend.mjs [taskId,taskId,...]
 * Env: EVAL_HISTORY_FILE (default ~/.local/share/argo/eval-runs/history.jsonl)
 *      EVAL_VARIANCE_RATIO (default 2 — flag a task if max/min wall or iters exceeds this)
 *      EVAL_SPEED_TARGET (default 1.5 — Argo:Hermes wall-clock ratio target, flagged if exceeded)
 *      EVAL_RUBRIC (default: newest version present — restrict the report to one version)
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

const allRows = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Quarantine (see header note 3). Not deleted — skipped, and counted out loud.
const invalid = allRows.filter(r => r.invalid === true);
const rows = allRows.filter(r => r.invalid !== true);

// Rubric version: rows written before BATCH 1 carry no `rubricVersion`. A row with a
// numeric `score` and a `scoreBreakdown.speed` term is v1; a backfilled pass/fail-only
// row (score:null) is v0. Inferred, never assumed, and never mixed.
const versionOf = (r) => {
  if (r.rubricVersion != null) return Number(r.rubricVersion);
  if (r.scoreBreakdown && 'speed' in r.scoreBreakdown) return 1;
  return 0;
};
const versionsPresent = [...new Set(rows.map(versionOf))].sort((a, b) => a - b);
const requested = process.env.EVAL_RUBRIC ? Number(process.env.EVAL_RUBRIC) : null;

const stat = (nums) => {
  const v = nums.filter(n => n != null);
  if (v.length === 0) return { min: null, mean: null, max: null };
  return { min: Math.min(...v), mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length), max: Math.max(...v) };
};
const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
const last = (arr) => (arr.length ? arr[arr.length - 1] : null);
// Never default a missing harness to a real one — that is how 17 rows got mis-attributed.
const harnessOf = (r) => (typeof r.harness === 'string' && r.harness ? r.harness : 'unattrib');
const agentsLabel = (r) => (r.agents === true ? 'multi' : r.agents === false ? 'single' : '?');

console.log(`Trend over ${rows.length} valid run(s) — ${HISTORY_FILE}`);
if (invalid.length) console.log(`${invalid.length} row(s) QUARANTINED (invalid:true) and excluded: ${[...new Set(invalid.map(r => r.taskId))].join(', ')}`);
const unattrib = rows.filter(r => harnessOf(r) === 'unattrib').length;
if (unattrib) console.log(`${unattrib} row(s) have no \`harness\` field — reported as 'unattrib' and EXCLUDED from every cross-harness comparison.`);
console.log(`rubric version(s) present: ${versionsPresent.join(', ')}${versionsPresent.length > 1 ? '  ← NOT COMPARABLE, reported separately' : ''}\n`);

for (const version of versionsPresent) {
  if (requested != null && version !== requested) continue;
  const vRows = rows.filter(r => versionOf(r) === version);
  const label = version === 0 ? 'v0 (backfilled pass/fail only, no score)'
    : version === 1 ? 'v1 (70 correctness + 15 integrity + 15 SPEED — speed was the only term that ever moved)'
      : `v${version} (60 targeted correctness + 20 quality + 20 reliability, two binary gates, speed excluded)`;
  console.log(`── RUBRIC ${label} — ${vRows.length} row(s) ─────────────────────────────`);

  const byTask = new Map();
  for (const r of vRows) {
    if (ONLY.length && !ONLY.includes(r.taskId)) continue;
    if (!byTask.has(r.taskId)) byTask.set(r.taskId, []);
    byTask.get(r.taskId).push(r);
  }
  if (byTask.size === 0) { console.log('(no rows match)\n'); continue; }

  console.log(pad('task', 26) + pad('harness', 10) + pad('agents', 8) + pad('n', 4) + pad('pass', 7)
    + pad(version >= 2 ? 'c/60' : 'score', 8) + pad(version >= 2 ? 'batch/100' : '', 11) + pad('wall min/mean/max', 20) + 'flag');

  for (const [taskId, taskRows] of [...byTask.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Split by (harness, agents) — pooling multi-agent and single-loop runs under one
    // `argo` label hid the only architecture comparison the ledger contains.
    const byCell = new Map();
    for (const r of taskRows) {
      const key = `${harnessOf(r)}|${agentsLabel(r)}`;
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push(r);
    }
    for (const [key, cell] of byCell.entries()) {
      const [harness, agents] = key.split('|');
      const passes = cell.filter(r => r.completed).length;
      const wall = stat(cell.map(r => (r.wallMs != null ? Math.round(r.wallMs / 1000) : null)));
      const flags = [];
      if (wall.min != null && wall.min > 0 && wall.max / wall.min >= VARIANCE_RATIO) flags.push(`wall ${(wall.max / wall.min).toFixed(1)}x`);
      if (passes !== cell.length) flags.push('FAILS SEEN');
      if (passes === cell.length && cell.length >= 3) flags.push('SATURATED (no information)');
      if (cell.length < 3) flags.push(`n=${cell.length} — not evidence`);
      const voided = cell.filter(r => r.scoreBreakdown && r.scoreBreakdown.gatePassed === false).length;
      if (voided) flags.push(`${voided} GATE-VOIDED`);
      if (cell.some(r => r.counterSelfCheck === 'FAIL')) flags.push('counter self-check FAILED');

      let col1 = '?', col2 = '';
      if (version >= 2) {
        col1 = String(stat(cell.map(r => (r.scoreBreakdown ? r.scoreBreakdown.correctness : null))).mean ?? '?');
        // v2 composite = per-batch, because reliability is a pass rate over that batch's k runs.
        const byBatch = new Map();
        for (const r of cell) { const b = r.batchId || '(no batch)'; if (!byBatch.has(b)) byBatch.set(b, []); byBatch.get(b).push(r); }
        const totals = [];
        for (const [, br] of byBatch) {
          const cs = br.map(r => r.scoreBreakdown?.correctness).filter(x => x != null);
          const qs = br.map(r => r.scoreBreakdown?.quality).filter(x => x != null);
          if (cs.length !== br.length || qs.length !== br.length) continue;
          const pr = br.filter(r => r.completed).length / br.length;
          totals.push(Math.round(cs.reduce((a, b) => a + b, 0) / cs.length + qs.reduce((a, b) => a + b, 0) / qs.length + 20 * pr));
        }
        col2 = totals.length ? totals.join('/') : 'n/a';
      } else {
        col1 = String(stat(cell.map(r => r.score)).mean ?? '?');
      }

      console.log(
        pad(taskId, 26) + pad(harness, 10) + pad(agents, 8) + pad(cell.length, 4) + pad(`${passes}/${cell.length}`, 7)
        + pad(col1, 8) + pad(col2, 11) + pad(`${wall.min}/${wall.mean}/${wall.max}`, 20) + flags.join(', '),
      );
    }

    // Speed ratio, reported only WITHIN one rubric version and only between rows that
    // actually say which harness produced them. Wall-clock is no longer part of the score
    // (EVAL-PLAN §3.1) — this is a cost comparison, and it is untrustworthy while the
    // 5-8x per-iteration anomaly (§1.6a) is unexplained and Argo's turn budget is
    // uncapped against Hermes's 60, so both caveats are printed with it.
    const argoRuns = taskRows.filter(r => harnessOf(r) === 'argo');
    const hermesRuns = taskRows.filter(r => harnessOf(r) === 'hermes');
    if (argoRuns.length && hermesRuns.length) {
      const a = last(argoRuns)?.wallMs, h = last(hermesRuns)?.wallMs;
      if (a && h) {
        const ratio = a / h;
        console.log(pad('', 26) + `cost ratio (argo/hermes wall): ${ratio.toFixed(2)}x (target <= ${SPEED_TARGET}x — ${ratio <= SPEED_TARGET ? 'OK' : 'OVER'});`
          + ` UNTRUSTWORTHY unless the runs were not interleaved and turn budgets were equal (Argo turns=${last(argoRuns)?.iters ?? '?'} vs Hermes max_turns=${last(hermesRuns)?.maxIterations ?? '?'})`);
      }
    }
  }
  console.log('');
}

if (versionsPresent.length > 1) {
  console.log('REFUSING to produce a single cross-version trend line: the scoring changed. Compare pass/fail (and `legacyCheck`) across versions, not scores.');
}
