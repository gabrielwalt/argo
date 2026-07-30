import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTaskList,
  activeTask,
  completeActiveTask,
  allDone,
  reconcile,
  renderTaskLedger,
  progress,
  normalizeTitle,
  type TaskList,
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

// ── progress ──────────────────────────────────────────────────────

test('progress: correct done/total', () => {
  let list = createTaskList('obj', ['a', 'b', 'c'])
  assert.deepEqual(progress(list), { done: 0, total: 3 })
  list = completeActiveTask(list)
  assert.deepEqual(progress(list), { done: 1, total: 3 })
  assert.deepEqual(progress(createTaskList('obj', [])), { done: 0, total: 0 })
})
