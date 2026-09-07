#!/usr/bin/env node
/**
 * Quality judge for e2e.mjs runs (docs/overnight-log.md, Phase 5). Deterministic
 * pass/fail (the eval's own gates + seeded-test fraction) answers "did it work" — this
 * answers "was it done well": did the run stay on-goal, waste frames/iterations, show
 * drift or hallucination, and did the multi-agent orchestration (which frames ran, in
 * what order, any standups/replans) actually make sense for the task. Graded AFTER
 * pass/fail, never instead of it (Anthropic's "demystifying evals for AI agents": prefer
 * deterministic checks, layer a model judge only for what tests can't see).
 *
 * Reuses the actor-critic self-critique pattern already validated in this codebase
 * (src/critic.ts: qwen3.6 judging qwen3.6's own work, format:"json", temp 0.2) rather
 * than inventing a new judging mechanism — that is the only critic setup this project
 * has ever confirmed reliable (docs/eval-log.md, 2026-07-27 SUPERVISOR entries).
 *
 * BATCH 1 changes:
 *  - `judgeRun()` is EXPORTED and called inline by e2e.mjs/hermes.mjs, because rubric v2
 *    puts 20 of the 100 points behind this judge (EVAL-PLAN §3.1). It can no longer be an
 *    optional after-the-fact pass. The judge is capped at 20 points and gated behind the
 *    deterministic checks, preserving "deterministic first, judge second, never instead".
 *  - Artifacts are keyed by RUN ID, not task id. At k=3 the old `<taskId>.json` naming
 *    destroyed two thirds of the evidence as it was produced.
 *  - A missing ledger no longer means "skip". The baseline single-loop path never writes
 *    one, so returning null there would have made every baseline run unscoreable and the
 *    architecture comparison impossible. It judges the diff with an explicit
 *    "(single-loop run: no orchestration log)" placeholder instead, and reports
 *    orchestration_sane accordingly.
 *
 * Usage (still works standalone, for re-judging saved artifacts):
 *        node scripts/eval/quality-judge.mjs <runId|taskId> [...]
 *        node scripts/eval/quality-judge.mjs --all
 * Reads:  ~/.local/share/argo/eval-runs/ledgers/<id>.jsonl (saved by e2e.mjs)
 *         ~/.local/share/argo/eval-runs/diffs/<id>.diff    (saved by e2e.mjs)
 * Env:    OLLAMA_HOST (default http://localhost:11434), JUDGE_MODEL (default qwen3.6:latest)
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Ollama } from 'ollama';

const RUNS_DIR = process.env.EVAL_RUNS_DIR || path.join(os.homedir(), '.local/share/argo/eval-runs');
const LEDGER_DIR = process.env.EVAL_LEDGER_DIR || path.join(RUNS_DIR, 'ledgers');
const DIFF_DIR = process.env.EVAL_DIFF_DIR || path.join(RUNS_DIR, 'diffs');
const OUT_DIR = process.env.EVAL_JUDGE_DIR || path.join(RUNS_DIR, 'judgments');
const MODEL = process.env.JUDGE_MODEL || 'qwen3.6:latest';
const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://localhost:11434' });

const LEDGER_DIGEST_CAP = 6000; // per-entry-summary chars stay small; this caps the whole digest
const DIFF_CAP = 6000;
const NO_LEDGER = '(single-loop run: no orchestration log — one Agent.chat() loop, no delegations)';

// Compact digest of the ledger: role, action (delegation/conclusion/standup/injection),
// and a short summary — NOT the raw episode graph (fullContent), which is often huge and
// not needed to judge orchestration sanity/goal drift at this level.
function digestLedgerFile(file) {
  if (!file || !existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const rows = [];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.kind === 'delegation') rows.push(`DELEGATE -> ${e.to} (frame ${e.frameId}): ${(e.prompt || '').slice(0, 200).replace(/\n/g, ' ')}`);
    else if (e.kind === 'conclusion') rows.push(`CONCLUDE  ${e.frameId} [${e.status}]: ${(e.summary || '').slice(0, 300).replace(/\n/g, ' ')}`);
    else if (e.kind === 'standup') rows.push(`STANDUP   ${(e.message || e.reason || '').slice(0, 200).replace(/\n/g, ' ')}`);
    else if (e.kind === 'injection') rows.push(`INJECT    -> ${e.targetFrameId} (${e.reason}): ${(e.message || '').slice(0, 200).replace(/\n/g, ' ')}`);
  }
  const digest = rows.join('\n');
  return digest.length > LEDGER_DIGEST_CAP ? digest.slice(0, LEDGER_DIGEST_CAP) + '\n…(truncated)' : digest;
}

const capDiff = (diff) => {
  if (!diff) return '(no diff captured)';
  return diff.length > DIFF_CAP ? diff.slice(0, DIFF_CAP) + '\n…(truncated)' : diff;
};

const JUDGE_SYSTEM_PROMPT = `You are a strict senior engineer reviewing a JUST-COMPLETED coding-agent run inside Argo's multi-agent harness (Dispatcher, Planner, Implementer). You did not do this work — you are reviewing it after the fact, with the orchestration log (who was delegated what, in what order, and their conclusions) and the final code diff. A separate DETERMINISTIC check already confirmed whether the tests pass — your job is quality, not pass/fail: did the run stay on-goal, waste effort, show drift or hallucination, and did the orchestration itself make sense for a task of this size. Be concrete and skeptical — cite the specific frame or diff line, not a vague impression. Return ONLY a JSON object with this exact shape:
{
  "goal_completeness": <0-10 integer, does the diff actually accomplish the stated objective, not just pass tests it might have gamed>,
  "wasted_actions": [<short strings, each one concrete wasted/redundant action or frame — empty array if none>],
  "drift_or_hallucination": [<short strings, each one concrete instance of the agent acting on a false premise, inventing something not in the repo, or working on the wrong thing — empty array if none>],
  "orchestration_sane": <boolean, did the SEQUENCE of frames (which roles ran, in what order, any standups/replans) make sense for a task this size, not more or less ceremony than warranted>,
  "orchestration_notes": "<one or two sentences justifying orchestration_sane>",
  "overall_notes": "<2-3 sentences, the single most important thing a human reviewer should know about this run>"
}`;

function buildUserPrompt(taskId, objective, ledgerDigest, diff) {
  return `TASK: ${taskId}\nOBJECTIVE (as given to the agent): ${objective}\n\nORCHESTRATION LOG (delegations/conclusions/standups, most recent last):\n${ledgerDigest}\n\nFINAL CODE DIFF:\n${diff}`;
}

/**
 * Judge ONE run. Returns the verdict object with `outPath` attached, or null if the judge
 * is unreachable / returned unparseable JSON. Returning null is load-bearing: rubric v2
 * then reports quality:null and REFUSES to produce a composite score, rather than
 * silently awarding the 20 quality points a judge never actually granted.
 *
 * @param {{runId:string, taskId:string, objective:string, ledgerPath?:string|null,
 *          diffText?:string|null}} a
 */
export async function judgeRun({ runId, taskId, objective, ledgerPath = null, diffText = null }) {
  const id = runId || taskId;
  const ledgerDigest = digestLedgerFile(ledgerPath || path.join(LEDGER_DIR, `${id}.jsonl`)) ?? NO_LEDGER;
  const diff = capDiff(diffText != null ? diffText
    : (existsSync(path.join(DIFF_DIR, `${id}.diff`)) ? readFileSync(path.join(DIFF_DIR, `${id}.diff`), 'utf8') : null));
  let resp;
  try {
    resp = await ollama.chat({
      model: MODEL,
      format: 'json',
      stream: false,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(taskId || id, objective || '(not provided)', ledgerDigest, diff) },
      ],
      options: { temperature: 0.2 },
    });
  } catch (e) {
    console.error(`[${id}] judge unreachable (${e.message}) — quality will be reported as null, not as full marks`);
    return null;
  }
  let verdict;
  try { verdict = JSON.parse(resp.message?.content ?? ''); } catch {
    console.error(`[${id}] judge returned unparseable JSON:`, resp.message?.content?.slice(0, 300));
    return null;
  }
  if (!verdict || typeof verdict !== 'object' || !Array.isArray(verdict.drift_or_hallucination)) {
    console.error(`[${id}] judge verdict missing drift_or_hallucination[] — treating as unavailable`);
    return null;
  }
  verdict.hadLedger = ledgerDigest !== NO_LEDGER;
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${id}.json`);
  writeFileSync(outPath, JSON.stringify(verdict, null, 2));
  verdict.outPath = outPath;
  return verdict;
}

function printVerdict(id, v) {
  if (!v) return;
  console.log(`\n=== ${id} ===`);
  console.log(`goal_completeness: ${v.goal_completeness}/10   orchestration_sane: ${v.orchestration_sane}   ledger: ${v.hadLedger ? 'yes' : 'no (single-loop)'}`);
  if (v.wasted_actions?.length) console.log(`wasted_actions:\n  - ${v.wasted_actions.join('\n  - ')}`);
  if (v.drift_or_hallucination?.length) console.log(`drift_or_hallucination:\n  - ${v.drift_or_hallucination.join('\n  - ')}`);
  console.log(`orchestration_notes: ${v.orchestration_notes}`);
  console.log(`overall_notes: ${v.overall_notes}`);
}

// Only run the CLI when invoked directly — e2e.mjs and hermes.mjs import judgeRun.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const ids = args[0] === '--all'
    ? (existsSync(LEDGER_DIR) ? readdirSync(LEDGER_DIR).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, '')) : [])
    : args;
  if (ids.length === 0) {
    console.error('Usage:  node scripts/eval/quality-judge.mjs <runId|taskId> [...] | --all');
    process.exit(1);
  }
  for (const id of ids) {
    // Standalone re-judging has no objective to hand (it lives in tasks.mjs, keyed by
    // task id, while an id here may be a runId of the form <ts>_<taskId>_r<n>).
    const taskId = id.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z?_/, '').replace(/_r\d+$/, '');
    const v = await judgeRun({ runId: id, taskId, objective: '(not provided — re-judged from saved artifacts)' });
    printVerdict(id, v);
  }
}
