#!/usr/bin/env node
/**
 * Quality judge for eval-e2e.mjs runs (docs/overnight-log.md, Phase 5). Deterministic
 * pass/fail (the eval's own `check`) answers "did it work" — this answers "was it done
 * well": did the run stay on-goal, waste frames/iterations, show drift or hallucination,
 * and did the multi-agent orchestration (which frames ran, in what order, any standups/
 * replans) actually make sense for the task. Graded AFTER pass/fail, never instead of it
 * (Anthropic's "demystifying evals for AI agents": prefer deterministic checks, layer a
 * model judge only for what tests can't see).
 *
 * Reuses the actor-critic self-critique pattern already validated in this codebase
 * (src/critic.ts: qwen3.6 judging qwen3.6's own work, format:"json", temp 0.2) rather
 * than inventing a new judging mechanism — that is the only critic setup this project
 * has ever confirmed reliable (docs/eval-log.md, 2026-07-27 SUPERVISOR entries).
 *
 * Usage: node scripts/eval-quality-judge.mjs <taskId> [<taskId> ...]
 *        node scripts/eval-quality-judge.mjs --all
 * Reads:  ~/.local/share/argo/eval-ledgers/<taskId>.jsonl (saved by eval-e2e.mjs)
 *         ~/.local/share/argo/eval-diffs/<taskId>.diff    (saved by eval-e2e.mjs)
 * Env:    OLLAMA_HOST (default http://localhost:11434), JUDGE_MODEL (default qwen3.6:latest)
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Ollama } from 'ollama';

const LEDGER_DIR = process.env.EVAL_LEDGER_DIR || path.join(os.homedir(), '.local/share/argo/eval-ledgers');
const DIFF_DIR = process.env.EVAL_DIFF_DIR || path.join(os.homedir(), '.local/share/argo/eval-diffs');
const OUT_DIR = process.env.EVAL_JUDGE_DIR || path.join(os.homedir(), '.local/share/argo/eval-judgments');
const MODEL = process.env.JUDGE_MODEL || 'qwen3.6:latest';
const ollama = new Ollama({ host: process.env.OLLAMA_HOST || 'http://localhost:11434' });

const LEDGER_DIGEST_CAP = 6000; // per-entry-summary chars stay small; this caps the whole digest
const DIFF_CAP = 6000;

// Compact digest of the ledger: role, action (delegation/conclusion/standup/injection),
// and a short summary — NOT the raw episode graph (fullContent), which is often huge and
// not needed to judge orchestration sanity/goal drift at this level.
function digestLedger(taskId) {
  const file = path.join(LEDGER_DIR, `${taskId}.jsonl`);
  if (!existsSync(file)) return null;
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

function readDiff(taskId) {
  const file = path.join(DIFF_DIR, `${taskId}.diff`);
  if (!existsSync(file)) return '(no diff captured)';
  const diff = readFileSync(file, 'utf8');
  return diff.length > DIFF_CAP ? diff.slice(0, DIFF_CAP) + '\n…(truncated)' : diff;
}

const JUDGE_SYSTEM_PROMPT = `You are a strict senior engineer reviewing a JUST-COMPLETED coding-agent run inside Argo's multi-agent harness (Boss/Jason, Planner/Tiphys, Implementer/Argus, Tester/Lynceus). You did not do this work — you are reviewing it after the fact, with the orchestration log (who was delegated what, in what order, and their conclusions) and the final code diff. A separate DETERMINISTIC check already confirmed whether the tests pass — your job is quality, not pass/fail: did the run stay on-goal, waste effort, show drift or hallucination, and did the orchestration itself make sense for a task of this size. Be concrete and skeptical — cite the specific frame or diff line, not a vague impression. Return ONLY a JSON object with this exact shape:
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

async function judgeOne(taskId, objective) {
  const ledgerDigest = digestLedger(taskId);
  if (ledgerDigest === null) {
    console.error(`[${taskId}] no ledger found at ${LEDGER_DIR} — skipping`);
    return null;
  }
  const diff = readDiff(taskId);
  const resp = await ollama.chat({
    model: MODEL,
    format: 'json',
    stream: false,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(taskId, objective || '(not provided)', ledgerDigest, diff) },
    ],
    options: { temperature: 0.2 },
  });
  let verdict;
  try { verdict = JSON.parse(resp.message?.content ?? ''); } catch {
    console.error(`[${taskId}] judge returned unparseable JSON:`, resp.message?.content?.slice(0, 300));
    return null;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, `${taskId}.json`), JSON.stringify(verdict, null, 2));
  return verdict;
}

function printVerdict(taskId, v) {
  if (!v) return;
  console.log(`\n=== ${taskId} ===`);
  console.log(`goal_completeness: ${v.goal_completeness}/10   orchestration_sane: ${v.orchestration_sane}`);
  if (v.wasted_actions?.length) console.log(`wasted_actions:\n  - ${v.wasted_actions.join('\n  - ')}`);
  if (v.drift_or_hallucination?.length) console.log(`drift_or_hallucination:\n  - ${v.drift_or_hallucination.join('\n  - ')}`);
  console.log(`orchestration_notes: ${v.orchestration_notes}`);
  console.log(`overall_notes: ${v.overall_notes}`);
}

const args = process.argv.slice(2);
const taskIds = args[0] === '--all'
  ? readdirSync(LEDGER_DIR).filter(f => f.endsWith('.jsonl')).map(f => f.replace('.jsonl', ''))
  : args;

if (taskIds.length === 0) {
  console.error('Usage: node scripts/eval-quality-judge.mjs <taskId> [<taskId> ...] | --all');
  process.exit(1);
}

for (const taskId of taskIds) {
  const v = await judgeOne(taskId);
  printVerdict(taskId, v);
}
