const fs = require('fs');
const { Ollama } = require('ollama');
const { updateCompactionState, validateCompactionState, emptyCompactionState, messagesToText } = require('./dist/compaction.js');

const prior = JSON.parse(fs.readFileSync('/private/tmp/claude-503/-Users-gwalt-Sources-adobe-argo/98b98476-d62e-400b-baa0-e4d8a289f5df/scratchpad/synthetic-prior.json', 'utf8'));

async function main() {
  const ollama = new Ollama({ host: 'http://localhost:11434' });
  const model = 'qwen3.6:latest';
  console.log('prior messages:', prior.length, 'workLog chars:', messagesToText(prior).length);

  const t0 = Date.now();
  const draft = await updateCompactionState(ollama, model, {}, emptyCompactionState(), prior);
  const t1 = Date.now();
  console.log(`updateCompactionState took ${t1 - t0}ms`);

  const sourceWorkLog = messagesToText(prior);
  const t2 = Date.now();
  const result = await validateCompactionState(ollama, model, {}, sourceWorkLog, draft);
  const t3 = Date.now();
  console.log(`validateCompactionState took ${t3 - t2}ms`);

  console.log(`total: ${t3 - t0}ms (old 60_000ms timeout would have ${(t1-t0) > 60000 || (t3-t2) > 60000 ? 'FAILED' : 'succeeded'} on at least one sub-call; new 180000ms timeout: ${(t1-t0) < 180000 && (t3-t2) < 180000 ? 'fits' : 'DOES NOT FIT'})`);
}

main().catch(e => { console.error('ERROR', e); process.exit(1); });
