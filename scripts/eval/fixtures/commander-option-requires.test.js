// eval-option-requires.test.js  --  EVAL FEATURE SPEC (not part of the commander baseline suite)
//
// Feature: Option.requires() — the inverse of the existing Option.conflicts(). Declares that
// an option may only be used when a companion option is also present.
//
// Why this is the CROSS-CUTTING rung: a correct implementation must touch four files that
// know nothing about each other.
//   lib/option.js   the builder + the `requiredWith` field
//   lib/command.js  a hierarchy-walking check, alongside _checkForConflictingOptions()
//   lib/help.js     optionDescription()'s extraInfo list
//   typings/index.d.ts  the declaration
// A model that finds only the builder passes 2 of 12 cases; one that finds the builder and
// the check passes 8; only a model that read all four files passes everything. That
// gradient is the point — the seeded suite is the partial-credit instrument.
//
// The design deliberately MIRRORS conflicts(): same accumulate-on-repeat semantics, same
// "a default value does not count as present" rule (lib/command.js
// _checkForConflictingLocalOptions filters on getOptionValueSource() !== 'default'), same
// `option '<flags>'` phrasing in the error. That is not a shortcut for the model — it is
// what makes the spec unambiguous enough to be a fair oracle.
//
// FLAT test() calls, no describe(): Node's TAP nests describe blocks, which collapses the
// eval's per-case granularity to one result per suite and destroys partial credit.

import { readFileSync } from 'node:fs';
import * as commander from '../index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function testProgram() {
  return new commander.Command()
    .exitOverride() // throw instead of process.exit
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
}

// ── lib/option.js: the builder ────────────────────────────────────────────────────────

test('requires: builder returns the option for chaining', () => {
  const option = new commander.Option('--alpha');
  assert.equal(option.requires('beta'), option);
});

test('requires: a single name is recorded in requiredWith', () => {
  const option = new commander.Option('--alpha').requires('beta');
  assert.deepEqual(option.requiredWith, ['beta']);
});

test('requires: an array of names is recorded in requiredWith', () => {
  const option = new commander.Option('--alpha').requires(['beta', 'gamma']);
  assert.deepEqual(option.requiredWith, ['beta', 'gamma']);
});

test('requires: repeated calls accumulate', () => {
  const option = new commander.Option('--alpha')
    .requires('beta')
    .requires(['gamma']);
  assert.deepEqual(option.requiredWith, ['beta', 'gamma']);
});

test('requires: requiredWith defaults to an empty array', () => {
  const option = new commander.Option('--alpha');
  assert.deepEqual(option.requiredWith, []);
});

// ── lib/command.js: the parse-time check ──────────────────────────────────────────────

test('requires: no error when the option is not used at all', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--beta'));
  program.addOption(new commander.Option('--alpha').requires('beta'));
  program.parse(['node', 'test']);
  assert.equal(program.opts().alpha, undefined);
});

test('requires: no error when the option and its companion are both used', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--beta'));
  program.addOption(new commander.Option('--alpha').requires('beta'));
  program.parse(['node', 'test', '--alpha', '--beta']);
  assert.equal(program.opts().alpha, true);
  assert.equal(program.opts().beta, true);
});

test('requires: error when the option is used without its companion', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--beta'));
  program.addOption(new commander.Option('--alpha').requires('beta'));
  assert.throws(
    () => program.parse(['node', 'test', '--alpha']),
    { message: "error: option '--alpha' requires option '--beta'" },
  );
});

test('requires: error names the first unsatisfied companion in requiredWith order', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--beta'));
  program.addOption(new commander.Option('--gamma'));
  program.addOption(
    new commander.Option('--alpha').requires(['beta', 'gamma']),
  );
  assert.throws(
    () => program.parse(['node', 'test', '--alpha', '--gamma']),
    { message: "error: option '--alpha' requires option '--beta'" },
  );
});

test('requires: a companion satisfied only by a default value does NOT count as present', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--beta <b>').default('d'));
  program.addOption(new commander.Option('--alpha').requires('beta'));
  assert.throws(
    () => program.parse(['node', 'test', '--alpha']),
    { message: "error: option '--alpha' requires option '--beta <b>'" },
  );
});

test('requires: a companion supplied on the command line satisfies the requirement', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--beta <b>').default('d'));
  program.addOption(new commander.Option('--alpha').requires('beta'));
  program.parse(['node', 'test', '--alpha', '--beta', 'given']);
  assert.equal(program.opts().beta, 'given');
});

test('requires: the check applies to a subcommand its own options', () => {
  const program = testProgram();
  const sub = program.command('sub');
  sub.addOption(new commander.Option('--beta'));
  sub.addOption(new commander.Option('--alpha').requires('beta'));
  sub.action(() => {});
  assert.throws(
    () => program.parse(['node', 'test', 'sub', '--alpha']),
    { message: "error: option '--alpha' requires option '--beta'" },
  );
});

// ── lib/help.js: the help output ──────────────────────────────────────────────────────

test('requires: help description reports the requirement', () => {
  const option = new commander.Option('--alpha', 'the alpha').requires('beta');
  const helper = new commander.Help();
  assert.equal(helper.optionDescription(option), 'the alpha (requires: beta)');
});

test('requires: help description joins multiple requirements with a comma', () => {
  const option = new commander.Option('--alpha', 'the alpha').requires([
    'beta',
    'gamma',
  ]);
  const helper = new commander.Help();
  assert.equal(
    helper.optionDescription(option),
    'the alpha (requires: beta, gamma)',
  );
});

test('requires: help description combines the requirement with other extras', () => {
  const option = new commander.Option('--alpha <a>', 'the alpha')
    .default('d')
    .requires('beta');
  const helper = new commander.Help();
  assert.equal(
    helper.optionDescription(option),
    'the alpha (default: "d", requires: beta)',
  );
});

// ── typings/index.d.ts: the declaration ───────────────────────────────────────────────
//
// This is a STRUCTURAL TEXT assertion, not a type check, and that is a deliberate
// limitation rather than an oversight: tsd reads exactly one entry file
// (typings/index.test-d.ts, since there is no tsd config in package.json), that file is
// tracked, and the integrity gate forbids editing tracked oracle files. So a new tsd
// assertion cannot be seeded. Asserting that the declaration EXISTS with a `this` return is
// the strongest check available without a compiler; `npm run check:type:ts` remains
// available separately as a regression guard on the file compiling at all.

// Bounded to ONE class body, so a declaration added to the wrong class does not pass and a
// typings restructure fails loudly rather than silently.
function typingsClassBlock(className) {
  const src = readFileSync(
    new URL('../typings/index.d.ts', import.meta.url),
    'utf8',
  );
  const marker = `export class ${className} {`;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `typings/index.d.ts must declare '${marker}'`);
  const rest = src.slice(start + marker.length);
  const next = rest.indexOf('\nexport class ');
  return next === -1 ? rest : rest.slice(0, next);
}

test('requires: typings declare Option.requires() returning this', () => {
  assert.match(
    typingsClassBlock('Option'),
    /^\s*requires\(\s*names\s*:\s*string\s*\|\s*string\[\]\s*\)\s*:\s*this\s*;/m,
  );
});

test('requires: typings declare the Option.requiredWith field', () => {
  assert.match(
    typingsClassBlock('Option'),
    /^\s*requiredWith\s*:\s*string\[\]\s*;/m,
  );
});
