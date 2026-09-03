const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runWithLimit } = require('../src/semaphore');

// Real async race condition, not a timing-sensitive flaky check: every task records
// how many tasks are CONCURRENTLY active when it starts and holds that for long
// enough that, if the limit is respected, no other task can start meanwhile. The
// assertion (max concurrent <= limit) is a correctness invariant regardless of
// exact scheduling — it's the concurrency count that must never be violated, not a
// specific timing.
test('never runs more than `limit` tasks concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  const limit = 2;
  const tasks = Array.from({ length: 8 }, (_, i) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 30));
    active--;
    return i;
  });

  const results = await runWithLimit(tasks, limit);

  assert.equal(results.length, 8);
  assert.ok(maxActive <= limit, `max concurrent was ${maxActive}, expected <= ${limit}`);
});

test('all tasks eventually run and results come back in call order', async () => {
  const tasks = [1, 2, 3, 4, 5].map(n => async () => n * 10);
  const results = await runWithLimit(tasks, 2);
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});
