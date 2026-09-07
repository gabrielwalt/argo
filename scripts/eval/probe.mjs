#!/usr/bin/env node
/**
 * Argo model-behaviour eval — fast, single-turn probes against Ollama that measure
 * the one thing the harness actually needs from a local model: does it emit a
 * NATIVE tool call (so the ReAct loop can act), or stall — narrate, or write the
 * tool call as text/XML in the message body (which Argo can't parse → the run ends)?
 *
 * It loads Argo's REAL Implementer role prompt (src/frames.ts's ROLE_IDENTITY.implementer
 * + ROLE_INSTRUCTIONS.implementer — so it tests whatever is in the file), sends
 * representative task cases with Argo's tool set, and prints a per-model scorecard.
 * Cheap (one turn per cell) so we can tune the role prompts and context budget without
 * slow end-to-end runs. The Implementer role is used as the probe target because it is
 * the one role every task case below actually exercises (write/edit/bash) — the harness
 * no longer has a single undifferentiated system prompt (see src/dispatch.ts's Dispatcher/
 * Planner/Implementer dispatch loop).
 *
 * The metric is NATIVE-TOOL-CALL RELIABILITY: PASS = the model emitted a native
 * tool call (any tool — appropriateness is a separate, human-judged column), OR,
 * for a pure question, gave a substantive direct answer. FAIL = it stalled.
 *
 * Every run is stamped with the harness git SHA and prints a ready-to-paste
 * "eval-log entry" block for docs/eval-log.md — that is the flywheel's memory.
 *
 * Run on the host (Ollama reachable; set OLLAMA_ORIGINS if calling cross-origin):
 *   npm run eval
 *   EVAL_RUNS=3 EVAL_MODELS="qwen3.6:latest,<candidate>" npm run eval
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';
// Default target model is qwen3.6 (the validated agentic model). Pass EVAL_MODELS to
// vet a candidate (a newer qwen, or any new local model) against the same probes.
const MODELS = (process.env.EVAL_MODELS || 'qwen3.6:latest').split(',').map(s => s.trim()).filter(Boolean);
const RUNS = Math.max(1, Number(process.env.EVAL_RUNS || 1));        // repeat each cell N times → pass RATE (temp>0 is noisy)
const NUM_CTX = Number(process.env.EVAL_NUM_CTX || 65536);
const TEMP = Number(process.env.EVAL_TEMP || 0.8);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HARNESS_SHA = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repo }).toString().trim(); } catch { return 'nogit'; } })();
const DIRTY = (() => { try { return execSync('git status --porcelain', { cwd: repo }).toString().trim().length > 0 ? '+dirty' : ''; } catch { return ''; } })();

// Extracts one role's ROLE_IDENTITY + ROLE_INSTRUCTIONS entry out of src/frames.ts by
// locating the object literal and pulling the string value keyed by `role` — a small,
// deliberately narrow parse (not a real TS parser) since both tables are simple
// `Record<Role, string>` literals with one string value per role, quoted with `'`.
function extractRoleEntry(src, tableName, role) {
  const tableStart = src.indexOf(`export const ${tableName}`);
  if (tableStart === -1) throw new Error(`${tableName} not found in src/frames.ts`);
  const roleStart = src.indexOf(`${role}:`, tableStart);
  if (roleStart === -1) throw new Error(`${tableName}.${role} not found in src/frames.ts`);
  // The value is one or more '...' + string-concatenated segments up to the line
  // ending in a bare comma before the next role key — collect every quoted segment.
  const afterColon = src.slice(roleStart + role.length + 1);
  // Stops at the next role key OR the table's own closing brace (the last role's
  // value has no following role key to bound it, only the literal's own `}`).
  const stopIdx = afterColon.search(/\n\s*(?:dispatcher|planner|implementer):|\n\}/);
  const segment = stopIdx === -1 ? afterColon : afterColon.slice(0, stopIdx);
  const parts = [...segment.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1].replace(/\\'/g, "'"));
  if (parts.length === 0) throw new Error(`could not parse ${tableName}.${role} in src/frames.ts`);
  return parts.join('');
}

function systemPrompt() {
  const src = readFileSync(path.join(repo, 'src/frames.ts'), 'utf8');
  const identity = extractRoleEntry(src, 'ROLE_IDENTITY', 'implementer');
  const instructions = extractRoleEntry(src, 'ROLE_INSTRUCTIONS', 'implementer');
  return `${identity}\n\n${instructions}`;
}

const fn = (name, description, props, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required } } });
const TOOLS = [
  fn('bash', 'Run a shell command in the sandbox container.', { command: { type: 'string' }, cwd: { type: 'string' } }, ['command']),
  fn('read_file', 'Read a file.', { path: { type: 'string' } }, ['path']),
  fn('write_file', 'Write a file.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fn('edit_file', 'Replace an exact string in a file.', { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, ['path', 'old_string', 'new_string']),
  fn('fetch_url', 'Fetch the text content of a URL (no JS).', { url: { type: 'string' } }, ['url']),
  fn('browser_fetch', 'Fetch a JavaScript-rendered page.', { url: { type: 'string' } }, ['url']),
  fn('web_search', 'Search the web for current information.', { query: { type: 'string' } }, ['query']),
  fn('conclude', 'End the turn with a status keyword and message.', { status: { type: 'string' }, message: { type: 'string' } }, ['status', 'message']),
];

// Representative cases. `allowDirect` = a substantive no-tool answer also counts as
// a pass (only the pure question). Everything else must emit SOME native tool call.
const TASKS = [
  { id: 'simple-question', kind: 'Q&A / read-only',  allowDirect: true,  prompt: 'What does the DECAY constant control in the wind simulation in /workspace/index.html? Answer concisely.' },
  { id: 'simple-edit',     kind: 'one-line change',  allowDirect: false, prompt: 'In /workspace/index.html, rename the constant DECAY to WIND_DECAY everywhere.' },
  { id: 'web-search',      kind: 'web search',       allowDirect: false, prompt: 'What is the current latest published version of the "playwright" npm package?' },
  { id: 'complex-plan',    kind: 'plan + implement', allowDirect: false, prompt: 'Make the wind in the simulation (/workspace/index.html) decay noticeably faster over time.' },
];

const TOOL_IN_TEXT = /<\s*\/?\s*(read_file|edit_file|write_file|bash|web_search|fetch_url|browser_fetch|conclude)\b|```json[\s\S]*?"name"\s*:/i;

async function probe(model, sys, prompt) {
  const body = { model, stream: false, messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }], tools: TOOLS, options: { temperature: TEMP, top_p: 0.9, top_k: 40, num_ctx: NUM_CTX } };
  const t0 = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  const tool = j.message?.tool_calls?.[0]?.function?.name ?? null;
  const content = j.message?.content ?? '';
  return { tool, ms: Date.now() - t0, unparsedInText: tool === null && TOOL_IN_TEXT.test(content), answered: content.trim().length > 40, error: j.error };
}

const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };

const sys = systemPrompt();
console.log(`Argo model eval — harness ${HARNESS_SHA}${DIRTY} — system prompt ${sys.length} chars — ${MODELS.length} model(s) × ${TASKS.length} task(s) × ${RUNS} run(s) — temp ${TEMP} — Ollama ${OLLAMA}\n`);
const score = new Map(MODELS.map(m => [m, { pass: 0, total: 0 }]));
for (const model of MODELS) {
  for (const task of TASKS) {
    let passes = 0; const tools = {}; let stallNote = '';
    for (let i = 0; i < RUNS; i++) {
      let r; try { r = await probe(model, sys, task.prompt); } catch (e) { r = { error: String(e) }; }
      const native = !r.error && r.tool !== null;
      const pass = native || (!r.error && task.allowDirect && r.answered);
      if (pass) passes++;
      const key = r.error ? 'ERR' : r.tool ? r.tool : r.unparsedInText ? 'stall(tool-in-text)' : task.allowDirect && r.answered ? 'direct-answer' : 'stall(prose)';
      tools[key] = (tools[key] || 0) + 1;
      if (!native && !pass) stallNote = key;
      score.get(model).total++; if (pass) score.get(model).pass++;
    }
    const rate = `${passes}/${RUNS}`;
    const dist = Object.entries(tools).map(([k, v]) => RUNS > 1 ? `${k}×${v}` : k).join(', ');
    const verdict = passes === RUNS ? 'PASS' : passes === 0 ? 'FAIL' : 'FLAKY';
    console.log(`${pad(verdict, 5)} ${pad(model, 20)} ${pad(task.kind, 18)} ${pad(rate, 6)} ${dist}`);
  }
  console.log('');
}
console.log('=== scorecard (native-tool-call reliability = harness can act) ===');
for (const model of MODELS) { const s = score.get(model); console.log(`${pad(model, 22)} ${s.pass}/${s.total} (${Math.round(100 * s.pass / s.total)}%)`); }

// Ready-to-paste block for docs/eval-log.md — the flywheel's memory.
const date = new Date().toISOString().slice(0, 10);
console.log(`\n--- eval-log entry (paste into docs/eval-log.md) ---`);
console.log(`### ${date} — fast probe — harness \`${HARNESS_SHA}${DIRTY}\``);
console.log(`Models: ${MODELS.join(', ')} · ${RUNS} run(s)/cell · temp ${TEMP} · native-tool-call reliability`);
for (const model of MODELS) { const s = score.get(model); console.log(`- ${model}: ${s.pass}/${s.total} (${Math.round(100 * s.pass / s.total)}%)`); }
console.log(`- Notes: <what changed since last run; what the numbers tell you>`);
