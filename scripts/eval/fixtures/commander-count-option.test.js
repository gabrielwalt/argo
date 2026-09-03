// eval-count-option.test.js  --  EVAL FEATURE SPEC (not part of the commander baseline suite)
//
// Feature: Option.count() — a boolean flag whose value is the NUMBER of times it appeared.
//
// Why this is the right first rung on the commander ladder: the whole change fits in
// lib/option.js, but you cannot know that without reading lib/command.js's addOption()
// (2790-line file) to find where an option's value is actually assigned. It is a
// LOCALISATION task with a small diff, in a codebase far too large to hold in context.
// The repeated-flag parsing (-vvv) already works in parseOptions(); only the accumulation
// is missing. A model that greps for the right thing finishes quickly; a model that reads
// linearly runs out of budget.
//
// FLAT test() calls, no describe(): Node's TAP nests describe blocks, which collapses the
// eval's per-case granularity to one result per suite and destroys partial credit.

import * as commander from '../index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('count: builder returns the option for chaining', () => {
  const option = new commander.Option('-v, --verbose', 'verbosity');
  assert.equal(option.count(), option);
});

test('count: value is undefined when the flag is not used', () => {
  const program = new commander.Command();
  program.addOption(new commander.Option('-v, --verbose').count());
  program.parse(['node', 'test']);
  assert.equal(program.opts().verbose, undefined);
});

test('count: value is 1 when the flag is used once', () => {
  const program = new commander.Command();
  program.addOption(new commander.Option('-v, --verbose').count());
  program.parse(['node', 'test', '-v']);
  assert.equal(program.opts().verbose, 1);
});

test('count: value is 2 when the long flag is repeated', () => {
  const program = new commander.Command();
  program.addOption(new commander.Option('-v, --verbose').count());
  program.parse(['node', 'test', '--verbose', '--verbose']);
  assert.equal(program.opts().verbose, 2);
});

test('count: combined short flags -vvv give 3', () => {
  const program = new commander.Command();
  program.addOption(new commander.Option('-v, --verbose').count());
  program.parse(['node', 'test', '-vvv']);
  assert.equal(program.opts().verbose, 3);
});

test('count: short and long forms accumulate together', () => {
  const program = new commander.Command();
  program.addOption(new commander.Option('-v, --verbose').count());
  program.parse(['node', 'test', '-v', '--verbose', '-v']);
  assert.equal(program.opts().verbose, 3);
});

test('count: a default of 0 is reported when the flag is not used', () => {
  const program = new commander.Command();
  program.addOption(new commander.Option('-v, --verbose').default(0).count());
  program.parse(['node', 'test']);
  assert.equal(program.opts().verbose, 0);
});

test('count: counting starts from the default value', () => {
  const program = new commander.Command();
  program.addOption(new commander.Option('-v, --verbose').default(0).count());
  program.parse(['node', 'test', '-v', '-v']);
  assert.equal(program.opts().verbose, 2);
});

test('count: a counted option takes no option-argument', () => {
  const program = new commander.Command();
  // The declared optional argument is required for the assertion to be about counting:
  // with no registered arguments, commander's _checkNumberOfArguments() treats any operand
  // as excess and errors (_allowExcessArguments defaults to false), which would fail this
  // test for a reason unrelated to the feature.
  program.argument('[operand]');
  program.addOption(new commander.Option('-v, --verbose').count());
  program.parse(['node', 'test', '-v', 'operand']);
  assert.equal(program.opts().verbose, 1);
  assert.deepEqual(program.args, ['operand']);
});

test('count: two independent counted options are counted separately', () => {
  const program = new commander.Command();
  program.addOption(new commander.Option('-v, --verbose').count());
  program.addOption(new commander.Option('-q, --quiet').count());
  program.parse(['node', 'test', '-vv', '-q']);
  assert.equal(program.opts().verbose, 2);
  assert.equal(program.opts().quiet, 1);
});
