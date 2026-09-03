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
 *   ARGO_WS_ROOT(~/Sources/test) EVAL_MODELS EVAL_RUNS EVAL_MAX_ITER(60) EVAL_TIMEOUT_S(900)
 */
import { readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import {
  TASKS, REPO, WS_ROOT, RUNS_DIR, wsPath, sh, shOk, baselineOf, resetWs,
  shScore, testFileTampered, rubricScore, appendHistory, latestReferenceWallMs,
} from './tasks.mjs';

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
// very next resetWs() (`git clean -fdx`) deletes it before it can be inspected. Saved
// out here, per task/run, so a later qualitative pass over orchestration behavior
// (which frames spawned, in what order, what the Boss decided) has something to
// read — the JSONL logs alone can't answer "did the Boss escalate," only the ledger
// records that.
const LEDGER_OUT_DIR = process.env.EVAL_LEDGER_DIR || path.join(RUNS_DIR, 'ledgers');
function saveLedger(ws, taskId) {
  const src = path.join(wsPath(ws), '.argo', 'ledger.jsonl');
  if (!existsSync(src)) return;
  mkdirSync(LEDGER_OUT_DIR, { recursive: true });
  try { copyFileSync(src, path.join(LEDGER_OUT_DIR, `${taskId}.jsonl`)); } catch { /* best-effort */ }
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
function saveDiff(ws, taskId, baseline) {
  mkdirSync(DIFF_OUT_DIR, { recursive: true });
  try {
    const diff = sh(`git diff ${baseline}`, wsPath(ws));
    writeFileSync(path.join(DIFF_OUT_DIR, `${taskId}.diff`), diff);
  } catch { /* best-effort — an empty/failed diff just means no quality judging for this task */ }
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
// "the newest file" — under the multi-agent harness (config.agents), ONE /chat call
// produces MULTIPLE log files: the dispatch's own top-level narrative (start/
// objective/task_graph/boss_verdict/replan/message/done) PLUS one separate file per
// spawned frame (Planner/Implementer/Tester/Boss each get their own real Agent.chat()
// log). Taking only the alphabetically-last file silently picked up whichever frame
// happened to write last (often a short Boss check, e.g. "it=2") and completely
// missed the real Implementer/Planner work — a baseline-era assumption ("one /chat
// call, one log file") that no longer holds.
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
function listJsonlFiles(ws) {
  const dir = path.join(LOGS_DIR, ws);
  try { return new Set(readdirSync(dir).filter(f => f.endsWith('.jsonl'))); } catch { return new Set(); }
}
function runMetrics(ws, newFiles) {
  const dir = path.join(LOGS_DIR, ws);
  let plan = 0, iters = 0, toolCalls = 0, gate = 0, reground = 0, steer = 0, errors = 0, frames = 0;
  let maxCtx = 0, compactions = 0, genTokens = 0, genMs = 0, topStatus, finalAnswer = '';
  for (const f of newFiles) {
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
const score = new Map(MODELS.map(m => [m, { pass: 0, total: 0, scoreSum: 0 }]));

for (const model of MODELS) {
  for (const task of TASKS.filter(t => { const o = (process.env.EVAL_TASKS || '').split(',').map(s => s.trim()).filter(Boolean); return o.length === 0 || o.includes(t.id) })) {
    for (let i = 0; i < RUNS; i++) {
      resetWs(task.ws, baselines[task.ws]);
      let completed = false, m = {}, rubric = { total: 0, correctness: 0, integrity: 0, speed: 0 };
      try {
        if (task.setup) sh(task.setup(wsPath(task.ws)), wsPath(task.ws));  // seed the failing test
        await post(task.ws, 'reset', {});
        const tRun = Date.now();
        const filesBefore = listJsonlFiles(task.ws);
        const HARNESS = ['1', 'true', 'on', 'yes'].includes((process.env.EVAL_HARNESS || '').trim().toLowerCase());
        await post(task.ws, 'chat', { message: task.prompt, model, options: OPTS, maxIterations: MAX_ITER, ...(HARNESS ? { tasks: true, memory: true, loop: true } : {}) });
        const w = await waitIdle(task.ws);
        const wallMs = Date.now() - tRun;
        const filesAfter = listJsonlFiles(task.ws);
        const newFiles = [...filesAfter].filter(f => !filesBefore.has(f));
        m = runMetrics(task.ws, newFiles);
        // check may be a shell command (string, run in the workspace) or a function
        // (m => boolean) for tasks with no file-based signal to check — e.g. a pure
        // Q&A task that should trigger the Boss's ANSWER mode and never touch the
        // workspace at all, verified against the run's own final answer text instead.
        // Run it ONCE via shScore (captures output for the rubric's test-fraction too)
        // rather than shOk-then-shScore separately — same command, same cost either way.
        let testResult = null;
        if (typeof task.check === 'function') {
          completed = w.idle && task.check(m);
        } else {
          testResult = shScore(task.check, wsPath(task.ws));
          completed = w.idle && testResult.fraction === 1;
        }
        const tampered = testFileTampered(task.ws, task.testFile);
        const referenceWallMs = latestReferenceWallMs(task.id, 'hermes');
        rubric = rubricScore({ testResult, tampered, wallMs, referenceWallMs });
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
      score.get(model).scoreSum += rubric.total;
      console.log(
        `${completed ? 'DONE' : 'FAIL'}  ${pad(model, 18)} ${pad(task.id, 16)} ${pad(m.status ?? '?', 8)} score=${pad(rubric.total, 3)}`
        + ` it=${pad(m.iters ?? '?', 3)} tool=${pad(m.toolCalls ?? '?', 3)} frames=${pad(m.frames ?? '?', 2)} plan=${m.plan ?? '?'} g=${m.gate ?? '?'} r=${m.reground ?? '?'} s=${m.steer ?? '?'} cmp=${m.compactions ?? '?'}`
        + ` | wall=${pad(secs(m.wallMs), 5)} tok/s=${pad(m.tokPerSec ?? '?', 4)} ctx≈${pad(m.maxCtx ?? '?', 6)} rss=${pad((m.peakRssMb ? m.peakRssMb + 'MB' : '?'), 7)} ${m.procSplit ?? ''}`
        + `${m.err ? '  ' + m.err : ''}`,
      );
      saveLedger(task.ws, task.id);
      saveDiff(task.ws, task.id, baselines[task.ws]);
      appendHistory({
        ts: new Date().toISOString(), harness: 'argo', harnessSha: HARNESS_SHA + DIRTY, model, taskId: task.id, ws: task.ws,
        completed, score: rubric.total, scoreBreakdown: rubric,
        status: m.status ?? null, iters: m.iters ?? null, toolCalls: m.toolCalls ?? null,
        frames: m.frames ?? null, plan: m.plan ?? null, gate: m.gate ?? null, reground: m.reground ?? null,
        steer: m.steer ?? null, compactions: m.compactions ?? null, wallMs: m.wallMs ?? null,
        tokPerSec: m.tokPerSec ?? null, maxCtx: m.maxCtx ?? null, peakRssMb: m.peakRssMb ?? null,
        err: m.err ?? null,
      });
      resetWs(task.ws, baselines[task.ws]);
    }
  }
  console.log('');
}
console.log('=== scorecard (task completion + rubric score, 0-100 — see tasks.mjs rubricScore) ===');
for (const model of MODELS) { const s = score.get(model); console.log(`${pad(model, 22)} ${s.pass}/${s.total} completed (${Math.round(100 * s.pass / s.total)}%) · avg score ${Math.round(s.scoreSum / s.total)}/100`); }

// Ready-to-paste block for docs/eval-log.md — the flywheel's memory.
const date = new Date().toISOString().slice(0, 10);
console.log(`\n--- eval-log entry (paste into docs/eval-log.md) ---`);
console.log(`### ${date} — E2E — harness \`${HARNESS_SHA}${DIRTY}\``);
console.log(`Models: ${MODELS.join(', ')} · ${RUNS} run(s)/task · max_iter ${MAX_ITER} · task completion + rubric score + cost`);
for (const model of MODELS) { const s = score.get(model); console.log(`- ${model}: ${s.pass}/${s.total} completed (${Math.round(100 * s.pass / s.total)}%) · avg score ${Math.round(s.scoreSum / s.total)}/100`); }
console.log(`- Cost: <wall-clock, tok/s, peak ctx, peak rss, CPU/GPU split from the rows above>`);
console.log(`- Notes: <what changed since last run; notable per-task behaviour>`);

async function post(ws, route, body) {
  const r = await fetch(`${URL_BASE}/ws/${ws}/${route}`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`POST /ws/${ws}/${route} → ${r.status} (is the workspace attached? run: argo ${wsPath(ws)})`);
  return r.json().catch(() => ({}));
}
