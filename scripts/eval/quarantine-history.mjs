#!/usr/bin/env node
/**
 * One-shot history.jsonl migration (BATCH 1 item 5, EVAL-PLAN §5.2 / §5.6).
 *
 * Does three things, all of them LABELLING — no row is ever deleted and no score is ever
 * changed. "Old rows keep their old score and are not retro-fitted" is the rule; the
 * point of labelling is that trend.mjs can then refuse to mix them.
 *
 *  1. QUARANTINE the fabricated `ERR` rows. Four rows at 2026-09-03T11:35:25 for
 *     bigproj-deps/effort/duedate-bug/observability have wallMs:null, status:"ERR",
 *     completed:false, score:0 and err "POST /ws/bigproj/reset → 409". They are not runs:
 *     the worker was busy after the documented detach/reattach that set ARGO_AGENTS=1, so
 *     the agent never started. e2e.mjs recorded a row anyway (now fixed — it writes no row
 *     when the run never starts), and trend.mjs has read them as real failures ever since,
 *     reporting bigproj-deps as 0/1 pass with mean score 0.
 *     Match criterion, deliberately narrow: status === 'ERR' AND wallMs is null/0 AND
 *     `err` matches /→ 4\d\d/ (an HTTP rejection from the worker, i.e. the run never
 *     began). A genuine failed run has a wall-clock.
 *
 *  2. STAMP `rubricVersion` on every existing row: 1 where a v1 `scoreBreakdown` with a
 *     `speed` term is present, else 0 (the 17 backfilled pass/fail-only rows, score:null).
 *     This is what lets trend.mjs separate v1 from v2 instead of plotting a discontinuity
 *     as if it were a trend.
 *
 *  3. FLAG unattributed rows with `harnessUnknown: true` where `harness` is null (17 of
 *     the first 33). It does NOT guess 'argo': the 17 backfilled rows describe an
 *     Argo-side battery, but "probably argo" written into the data is exactly the
 *     mis-attribution being removed. trend.mjs reports them as 'unattrib'.
 *
 * Usage:
 *   node scripts/eval/quarantine-history.mjs            # dry run: prints what would change
 *   node scripts/eval/quarantine-history.mjs --write     # rewrites, after a .bak copy
 * Env: EVAL_HISTORY_FILE (default ~/.local/share/argo/eval-runs/history.jsonl)
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HISTORY_FILE = process.env.EVAL_HISTORY_FILE || path.join(os.homedir(), '.local/share/argo/eval-runs/history.jsonl');
const WRITE = process.argv.includes('--write');

if (!existsSync(HISTORY_FILE)) { console.error(`No history file at ${HISTORY_FILE}`); process.exit(1); }

const lines = readFileSync(HISTORY_FILE, 'utf8').split('\n');
const out = [];
let quarantined = 0, stampedV1 = 0, stampedV0 = 0, flagged = 0, alreadyDone = 0, unparseable = 0;

const NEVER_STARTED = /→\s*4\d\d\b/;   // e.g. "POST /ws/bigproj/reset → 409"

for (const line of lines) {
  if (!line.trim()) { out.push(line); continue; }
  let r;
  try { r = JSON.parse(line); } catch { unparseable++; out.push(line); continue; }

  let touched = false;

  if (r.invalid === true) { alreadyDone++; } else if (
    r.status === 'ERR' && (r.wallMs == null || r.wallMs === 0) && NEVER_STARTED.test(String(r.err || ''))
  ) {
    r.invalid = true;
    r.invalidReason = 'run never started: the worker rejected POST /reset (HTTP 4xx, "Agent is busy") after a detach/reattach, so no agent run occurred. Recorded as a score-0 failure by the pre-BATCH-1 e2e.mjs; not a measurement.';
    quarantined++; touched = true;
  }

  if (r.rubricVersion == null) {
    if (r.scoreBreakdown && Object.prototype.hasOwnProperty.call(r.scoreBreakdown, 'speed')) { r.rubricVersion = 1; stampedV1++; }
    else { r.rubricVersion = 0; stampedV0++; }
    touched = true;
  }

  if (r.harness == null && r.harnessUnknown !== true) {
    r.harnessUnknown = true;
    r.harnessUnknownNote = 'harness field absent when this row was written (17 of the first 33). NOT inferred — an inferred harness is the mis-attribution this fixes.';
    flagged++; touched = true;
  }

  out.push(touched ? JSON.stringify(r) : line);
}

console.log(`${HISTORY_FILE}`);
console.log(`  rows read            ${lines.filter(l => l.trim()).length}`);
console.log(`  unparseable (kept)   ${unparseable}`);
console.log(`  quarantined now      ${quarantined}`);
console.log(`  already quarantined  ${alreadyDone}`);
console.log(`  stamped rubricVersion 1 / 0   ${stampedV1} / ${stampedV0}`);
console.log(`  flagged harnessUnknown        ${flagged}`);

if (!WRITE) { console.log('\nDry run. Re-run with --write to apply (a .bak copy is made first).'); process.exit(0); }

const bak = `${HISTORY_FILE}.pre-batch1.bak`;
copyFileSync(HISTORY_FILE, bak);
writeFileSync(HISTORY_FILE, out.join('\n'));
console.log(`\nWritten. Backup: ${bak}`);
