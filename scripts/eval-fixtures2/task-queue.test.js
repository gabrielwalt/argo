const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TaskQueue } = require('../src/task-queue');

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

test('runs at most `concurrency` tasks at once', async () => {
  const q = new TaskQueue({ concurrency: 2 });
  let current = 0, max = 0;
  const tasks = Array.from({ length: 6 }, () => q.add(async () => {
    current++; max = Math.max(max, current);
    await delay(20);
    current--;
    return 'ok';
  }));
  const results = await Promise.all(tasks);
  assert.equal(results.length, 6);
  assert.ok(max <= 2, `expected max concurrency <= 2, got ${max}`);
});

test('higher priority tasks run before lower priority ones queued at the same time', async () => {
  const q = new TaskQueue({ concurrency: 1 });
  const order = [];
  // The queue is idle when this first task is added, so it starts immediately (there
  // is nothing yet to compare priority against) — give it a moment to occupy the
  // single concurrency slot before queuing the rest together.
  const first = q.add(async () => { order.push('occupy'); await delay(15); });
  await delay(1);
  const rest = [
    q.add(async () => { order.push('low'); }, { priority: 0 }),
    q.add(async () => { order.push('high'); }, { priority: 10 }),
    q.add(async () => { order.push('mid'); }, { priority: 5 }),
  ];
  await Promise.all([first, ...rest]);
  assert.deepEqual(order, ['occupy', 'high', 'mid', 'low']);
});

test('retries a failing task and eventually succeeds', async () => {
  const q = new TaskQueue({ concurrency: 1, maxRetries: 3 });
  let attempts = 0;
  const result = await q.add(async () => {
    attempts++;
    if (attempts < 3) throw new Error('transient');
    return 'recovered';
  });
  assert.equal(result, 'recovered');
  assert.equal(attempts, 3);
});

test('rejects with the last error once retries are exhausted', async () => {
  const q = new TaskQueue({ concurrency: 1, maxRetries: 2 });
  let attempts = 0;
  await assert.rejects(
    q.add(async () => { attempts++; throw new Error('boom ' + attempts); }),
    /boom 3/,
  );
  assert.equal(attempts, 3); // 1 initial attempt + 2 retries
});

test('drain() resolves only after all queued tasks (including retries) finish', async () => {
  const q = new TaskQueue({ concurrency: 2, maxRetries: 2 });
  let attempts = 0;
  const settled = [];
  q.add(async () => { await delay(10); settled.push('a'); });
  q.add(async () => {
    attempts++;
    if (attempts < 2) throw new Error('retry me');
    await delay(5);
    settled.push('b');
  });
  await q.drain();
  assert.deepEqual(settled.sort(), ['a', 'b']);
});
