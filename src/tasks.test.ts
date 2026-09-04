import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTaskList,
  activeTask,
  completeActiveTask,
  recordActiveTaskSummary,
  allDone,
  reconcile,
  renderTaskLedger,
  renderTaskSummaries,
  progress,
  normalizeTitle,
  renderTaskGraph,
  type TaskList,
  type TaskGraph,
} from './tasks.js'

// ── normalizeTitle ────────────────────────────────────────────────

test('normalizeTitle: strips numbered and dash/star list markers', () => {
  assert.equal(normalizeTitle('1. Add auth'), 'add auth')
  assert.equal(normalizeTitle('2) Add auth'), 'add auth')
  assert.equal(normalizeTitle('- Add auth'), 'add auth')
  assert.equal(normalizeTitle('* Add auth'), 'add auth')
})

test('normalizeTitle: case- and whitespace-insensitive', () => {
  assert.equal(normalizeTitle('  Add   AUTH  '), 'add auth')
  assert.equal(normalizeTitle('add auth'), normalizeTitle('1. Add   Auth'))
})

// ── createTaskList ────────────────────────────────────────────────

test('createTaskList: first task active, rest pending, ids 1-based, revision 1', () => {
  const list = createTaskList('ship feature', ['a', 'b', 'c'])
  assert.equal(list.objective, 'ship feature')
  assert.equal(list.revision, 1)
  assert.deepEqual(list.tasks.map(t => [t.id, t.title, t.status]), [
    [1, 'a', 'active'],
    [2, 'b', 'pending'],
    [3, 'c', 'pending'],
  ])
})

test('createTaskList: blank steps are trimmed out', () => {
  const list = createTaskList('obj', ['a', '   ', '', 'b'])
  assert.deepEqual(list.tasks.map(t => t.title), ['a', 'b'])
  assert.equal(list.tasks[0].status, 'active')
})

test('createTaskList: exact-duplicate titles collapse to first occurrence', () => {
  const list = createTaskList('obj', ['Add auth', '1. add   AUTH', 'Wire UI'])
  assert.deepEqual(list.tasks.map(t => t.title), ['Add auth', 'Wire UI'])
  assert.deepEqual(list.tasks.map(t => t.id), [1, 2])
})

test('createTaskList: empty steps → empty tasks, still revision 1', () => {
  const list = createTaskList('obj', [])
  assert.deepEqual(list.tasks, [])
  assert.equal(list.revision, 1)
})

// ── createTaskList: executable per-task verification (verify) ─────

test('createTaskList: a plain string step has no verify', () => {
  const list = createTaskList('obj', ['a'])
  assert.equal(list.tasks[0].verify, undefined)
})

test('createTaskList: an object step {task, verify} populates title + verify', () => {
  const list = createTaskList('obj', [{ task: 'run the tests', verify: 'npm test' }])
  assert.equal(list.tasks[0].title, 'run the tests')
  assert.equal(list.tasks[0].verify, 'npm test')
  assert.equal(list.tasks[0].status, 'active')
})

test('createTaskList: an object step with no verify behaves like a plain string', () => {
  const list = createTaskList('obj', [{ task: 'plain object step' }])
  assert.equal(list.tasks[0].title, 'plain object step')
  assert.equal(list.tasks[0].verify, undefined)
})

test('createTaskList: mixed string and object steps both work, in order', () => {
  const list = createTaskList('obj', [
    'first, plain',
    { task: 'second, verified', verify: 'echo ok' },
    'third, plain',
  ])
  assert.deepEqual(list.tasks.map(t => [t.title, t.verify]), [
    ['first, plain', undefined],
    ['second, verified', 'echo ok'],
    ['third, plain', undefined],
  ])
})

test('createTaskList: dedupe-by-normalized-title still applies to object steps', () => {
  const list = createTaskList('obj', [
    { task: 'Add auth', verify: 'npm test -- auth' },
    { task: '1. add   AUTH', verify: 'echo other' },
    'Wire UI',
  ])
  assert.deepEqual(list.tasks.map(t => t.title), ['Add auth', 'Wire UI'])
  // First occurrence wins — including its verify command.
  assert.equal(list.tasks[0].verify, 'npm test -- auth')
})

test('createTaskList: blank/whitespace-only verify is treated as absent', () => {
  const list = createTaskList('obj', [{ task: 'a', verify: '   ' }])
  assert.equal(list.tasks[0].verify, undefined)
})

// ── activeTask ────────────────────────────────────────────────────

test('activeTask: returns the active task', () => {
  const list = createTaskList('obj', ['a', 'b'])
  assert.equal(activeTask(list)?.title, 'a')
})

test('activeTask: falls back to first pending when none active', () => {
  const list: TaskList = {
    objective: 'obj',
    revision: 1,
    tasks: [
      { id: 1, title: 'a', status: 'done' },
      { id: 2, title: 'b', status: 'pending' },
      { id: 3, title: 'c', status: 'pending' },
    ],
  }
  assert.equal(activeTask(list)?.title, 'b')
})

test('activeTask: null when empty or all done', () => {
  assert.equal(activeTask(createTaskList('obj', [])), null)
  const done: TaskList = {
    objective: 'obj',
    revision: 1,
    tasks: [{ id: 1, title: 'a', status: 'done' }],
  }
  assert.equal(activeTask(done), null)
})

// ── completeActiveTask ────────────────────────────────────────────

test('completeActiveTask: advances active→done and promotes next', () => {
  const list = createTaskList('obj', ['a', 'b', 'c'])
  const next = completeActiveTask(list)
  assert.deepEqual(next.tasks.map(t => t.status), ['done', 'active', 'pending'])
  assert.equal(next.revision, 1) // progress does not bump revision
})

test('completeActiveTask: does not mutate the input', () => {
  const list = createTaskList('obj', ['a', 'b'])
  const snapshot = JSON.stringify(list)
  completeActiveTask(list)
  assert.equal(JSON.stringify(list), snapshot)
})

test('completeActiveTask: no-op when nothing is active', () => {
  const allPending: TaskList = {
    objective: 'obj',
    revision: 1,
    tasks: [
      { id: 1, title: 'a', status: 'done' },
      { id: 2, title: 'b', status: 'done' },
    ],
  }
  const next = completeActiveTask(allPending)
  assert.deepEqual(next.tasks.map(t => t.status), ['done', 'done'])
  assert.notEqual(next, allPending) // fresh object
})

test('completeActiveTask: completing the last task → allDone true', () => {
  let list = createTaskList('obj', ['a', 'b'])
  list = completeActiveTask(list)
  list = completeActiveTask(list)
  assert.equal(allDone(list), true)
  assert.equal(activeTask(list), null)
})

// ── allDone ───────────────────────────────────────────────────────

test('allDone: empty list is true (nothing left to do)', () => {
  assert.equal(allDone(createTaskList('obj', [])), true)
})

test('allDone: mixed statuses is false', () => {
  assert.equal(allDone(createTaskList('obj', ['a', 'b'])), false)
})

test('allDone: every task done is true', () => {
  const list: TaskList = {
    objective: 'obj',
    revision: 1,
    tasks: [
      { id: 1, title: 'a', status: 'done' },
      { id: 2, title: 'b', status: 'done' },
    ],
  }
  assert.equal(allDone(list), true)
})

// ── reconcile ─────────────────────────────────────────────────────

test('reconcile: preserves done for a step whose normalized title still matches', () => {
  let list = createTaskList('obj', ['Add auth', 'Wire UI', 'Write tests'])
  list = completeActiveTask(list) // "Add auth" done, "Wire UI" active
  const next = reconcile(list, 'obj v2', ['1. add   AUTH', 'Wire UI', 'Deploy'])
  const auth = next.tasks.find(t => normalizeTitle(t.title) === 'add auth')
  assert.equal(auth?.status, 'done')
})

test('reconcile: a previously-done step that is removed drops out', () => {
  let list = createTaskList('obj', ['Add auth', 'Wire UI'])
  list = completeActiveTask(list) // "Add auth" done
  const next = reconcile(list, 'obj', ['Wire UI', 'Deploy'])
  assert.ok(!next.tasks.some(t => normalizeTitle(t.title) === 'add auth'))
  assert.deepEqual(next.tasks.map(t => t.title), ['Wire UI', 'Deploy'])
})

test('reconcile: a new step arrives as pending; first non-done becomes active', () => {
  let list = createTaskList('obj', ['Add auth', 'Wire UI'])
  list = completeActiveTask(list) // "Add auth" done
  const next = reconcile(list, 'obj', ['Add auth', 'New investigation', 'Wire UI'])
  assert.deepEqual(next.tasks.map(t => t.status), ['done', 'active', 'pending'])
  assert.equal(activeTask(next)?.title, 'New investigation')
})

test('reconcile: revision increments, objective updates, ids fresh/ordered, no mutation', () => {
  let list = createTaskList('old obj', ['a', 'b'])
  list = completeActiveTask(list)
  const snapshot = JSON.stringify(list)
  const next = reconcile(list, 'new obj', ['b', 'c', 'a'])
  assert.equal(next.revision, list.revision + 1)
  assert.equal(next.objective, 'new obj')
  assert.deepEqual(next.tasks.map(t => t.id), [1, 2, 3])
  assert.deepEqual(next.tasks.map(t => t.title), ['b', 'c', 'a'])
  assert.equal(JSON.stringify(list), snapshot) // input untouched
})

test('reconcile: all steps still pending → first becomes active', () => {
  const list = createTaskList('obj', ['a', 'b'])
  const next = reconcile(list, 'obj', ['x', 'y'])
  assert.deepEqual(next.tasks.map(t => t.status), ['active', 'pending'])
})

test('reconcile: when every new step was already done, none is active', () => {
  let list = createTaskList('obj', ['a', 'b'])
  list = completeActiveTask(list)
  list = completeActiveTask(list) // both done
  const next = reconcile(list, 'obj', ['a', 'b'])
  assert.deepEqual(next.tasks.map(t => t.status), ['done', 'done'])
  assert.equal(allDone(next), true)
})

// ── reconcile: executable per-task verification (verify) ──────────

test('reconcile: carries verify forward when the re-plan step omits it', () => {
  const list = createTaskList('obj', [{ task: 'Add auth', verify: 'npm test -- auth' }, 'Wire UI'])
  // Re-plan repeats "Add auth" as a bare string (no verify given this time).
  const next = reconcile(list, 'obj v2', ['Add auth', 'Wire UI', 'Deploy'])
  const auth = next.tasks.find(t => normalizeTitle(t.title) === 'add auth')
  assert.equal(auth?.verify, 'npm test -- auth')
})

test('reconcile: a freshly-supplied verify overrides the previously carried one', () => {
  const list = createTaskList('obj', [{ task: 'Add auth', verify: 'npm test -- auth' }])
  const next = reconcile(list, 'obj v2', [{ task: 'Add auth', verify: 'npm run e2e:auth' }])
  const auth = next.tasks.find(t => normalizeTitle(t.title) === 'add auth')
  assert.equal(auth?.verify, 'npm run e2e:auth')
})

test('reconcile: a step that never had a verify still has none after re-plan', () => {
  const list = createTaskList('obj', ['Wire UI'])
  const next = reconcile(list, 'obj', ['Wire UI', 'Deploy'])
  const wireUi = next.tasks.find(t => normalizeTitle(t.title) === 'wire ui')
  assert.equal(wireUi?.verify, undefined)
})

test('reconcile: mixed string/object newSteps work together, done-state still preserved', () => {
  let list = createTaskList('obj', ['Add auth', { task: 'Wire UI', verify: 'npm run build' }])
  list = completeActiveTask(list) // "Add auth" done, "Wire UI" active
  const next = reconcile(list, 'obj', ['Add auth', { task: 'Wire UI', verify: 'npm run build' }, 'Deploy'])
  const auth = next.tasks.find(t => normalizeTitle(t.title) === 'add auth')
  const wireUi = next.tasks.find(t => normalizeTitle(t.title) === 'wire ui')
  assert.equal(auth?.status, 'done')
  assert.equal(wireUi?.verify, 'npm run build')
  assert.deepEqual(next.tasks.map(t => t.title), ['Add auth', 'Wire UI', 'Deploy'])
})

// ── renderTaskLedger ──────────────────────────────────────────────

test('renderTaskLedger: shows [x]/[→]/[ ], marks CURRENT, numbers tasks', () => {
  let list = createTaskList('ship it', ['first', 'second', 'third'])
  list = completeActiveTask(list) // first done, second active
  const out = renderTaskLedger(list)
  assert.ok(out.includes('Objective: ship it'))
  assert.ok(out.includes('[x] 1. first'))
  assert.ok(out.includes('[\u2192] 2. CURRENT: second'))
  assert.ok(out.includes('[ ] 3. third'))
  assert.ok(out.includes('work ONLY the current task'))
})

test('renderTaskLedger: empty list → empty string', () => {
  assert.equal(renderTaskLedger(createTaskList('obj', [])), '')
})

test('renderTaskLedger: hints "(auto-verified)" only for steps with a verify command', () => {
  const list = createTaskList('obj', [{ task: 'checked step', verify: 'npm test' }, 'manual step'])
  const out = renderTaskLedger(list)
  assert.ok(out.includes('CURRENT: checked step (auto-verified)'))
  assert.ok(out.includes('[ ] 2. manual step'))
  assert.ok(!out.includes('manual step (auto-verified)'))
})

// ── progress ──────────────────────────────────────────────────────

test('progress: correct done/total', () => {
  let list = createTaskList('obj', ['a', 'b', 'c'])
  assert.deepEqual(progress(list), { done: 0, total: 3 })
  list = completeActiveTask(list)
  assert.deepEqual(progress(list), { done: 1, total: 3 })
  assert.deepEqual(progress(createTaskList('obj', [])), { done: 0, total: 0 })
})

// ── recordActiveTaskSummary ────────────────────────────────────────

test('recordActiveTaskSummary: sets the summary on the active task only', () => {
  const list = createTaskList('obj', ['a', 'b'])
  const next = recordActiveTaskSummary(list, 'did the thing via the other thing')
  assert.equal(next.tasks[0].summary, 'did the thing via the other thing') // "a" is active
  assert.equal(next.tasks[1].summary, undefined)                          // "b" is pending, untouched
  assert.equal(next.tasks[0].status, 'active')                            // status unchanged
})

test('recordActiveTaskSummary: trims the text', () => {
  const list = createTaskList('obj', ['a'])
  const next = recordActiveTaskSummary(list, '  padded summary  \n')
  assert.equal(next.tasks[0].summary, 'padded summary')
})

test('recordActiveTaskSummary: does not mutate the input', () => {
  const list = createTaskList('obj', ['a', 'b'])
  const snapshot = JSON.stringify(list)
  recordActiveTaskSummary(list, 'a summary')
  assert.equal(JSON.stringify(list), snapshot)
})

test('recordActiveTaskSummary: no-op (fresh copy) when nothing is active', () => {
  const allDoneList: TaskList = {
    objective: 'obj',
    revision: 1,
    tasks: [{ id: 1, title: 'a', status: 'done' }],
  }
  const next = recordActiveTaskSummary(allDoneList, 'irrelevant')
  assert.deepEqual(next.tasks, allDoneList.tasks)
  assert.notEqual(next, allDoneList) // fresh object
  assert.equal(next.tasks[0].summary, undefined)
})

// ── reconcile: summary carry-forward ───────────────────────────────

test('reconcile: carries the summary forward for a step preserved as done', () => {
  let list = createTaskList('obj', ['Add auth', 'Wire UI'])
  list = recordActiveTaskSummary(list, 'Implemented auth via the existing session module.')
  list = completeActiveTask(list) // "Add auth" done, with its summary
  const next = reconcile(list, 'obj v2', ['1. add   AUTH', 'Wire UI', 'Deploy'])
  const auth = next.tasks.find(t => normalizeTitle(t.title) === 'add auth')
  assert.equal(auth?.status, 'done')
  assert.equal(auth?.summary, 'Implemented auth via the existing session module.')
})

test('reconcile: a step that is NOT preserved as done gets no carried summary', () => {
  let list = createTaskList('obj', ['Add auth', 'Wire UI'])
  list = recordActiveTaskSummary(list, 'Implemented auth via the existing session module.')
  // "Add auth" never completed (still active) — reconcile brings it back as pending/active.
  const next = reconcile(list, 'obj v2', ['Add auth', 'Wire UI'])
  const auth = next.tasks.find(t => normalizeTitle(t.title) === 'add auth')
  assert.notEqual(auth?.status, 'done')
  assert.equal(auth?.summary, undefined)
})

// ── renderTaskSummaries ─────────────────────────────────────────────

test('renderTaskSummaries: numbers tasks with title, status, and summary', () => {
  let list = createTaskList('ship it', ['first', 'second'])
  list = recordActiveTaskSummary(list, 'Did the first thing by doing X.')
  list = completeActiveTask(list) // "first" done with its summary; "second" now active
  const out = renderTaskSummaries(list)
  assert.ok(out.includes('1. first [done]'))
  assert.ok(out.includes('Did the first thing by doing X.'))
  assert.ok(out.includes('2. second [active]'))
})

test('renderTaskSummaries: a task with no recorded summary shows the placeholder', () => {
  const list = createTaskList('obj', ['only step'])
  const out = renderTaskSummaries(list)
  assert.ok(out.includes('1. only step [active]'))
  assert.ok(out.includes('(no summary recorded)'))
})

// ── TASK GRAPH — mostly REMOVED (2026-09, "iterative planner"). TaskStep,
// createTaskGraph, nextStep, allStepsDone are gone — the Planner no longer produces
// any harness-owned plan object (see dispatch.ts's module header). TaskGraph +
// renderTaskGraph survive only as an inert legacy shape kept for two off-limits
// files (ledger.ts, eviction.ts) that still reference them — dispatch.ts's new flow
// never constructs one. Testing the shape directly (no createTaskGraph helper to
// build one) since that helper is gone too.

test('renderTaskGraph: lists steps in order with role and prompt (legacy shape, no longer constructed by dispatch.ts)', () => {
  const graph: TaskGraph = {
    objective: 'ship it',
    revision: 1,
    steps: [
      { id: 's1', role: 'implementer', prompt: 'do the first thing' },
      { id: 's2', role: 'tester', prompt: 'verify the first thing' },
    ],
  }
  const out = renderTaskGraph(graph)
  assert.ok(out.includes('s1. [implementer] do the first thing'))
  assert.ok(out.includes('s2. [tester] verify the first thing'))
})

test('renderTaskGraph: empty graph renders empty string', () => {
  assert.equal(renderTaskGraph({ objective: 'obj', revision: 1, steps: [] }), '')
})
