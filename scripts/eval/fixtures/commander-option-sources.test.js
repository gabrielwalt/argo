// eval-option-sources.test.js  --  EVAL FEATURE SPEC (not part of the commander baseline suite)
//
// Feature (C of three): Command.optionValueSources() — return an object mapping each option's
// attribute name to where its value came from ('cli' | 'default' | 'env' | 'implied' | 'config').
// The per-option accessor getOptionValueSource(key) already exists (lib/command.js:962); what is
// missing is the whole-command view. The smallest of the three features and the only one
// confined to lib/command.js + typings — deliberately, so a run that finishes only one feature
// most likely finishes THIS one, which makes the partial-credit gradient informative about
// ordering rather than just about count.
//
// Seeded by both commander-audit-trio (one prompt) and commander-continuity (turn 3 of three),
// byte-identical, so the pair is an A/B on prompt shape rather than on difficulty.
//
// FLAT test() calls, no describe(): Node's TAP nests describe blocks, which collapses the
// eval's per-case granularity to one result per suite and destroys partial credit.

import { readFileSync } from 'node:fs';
import * as commander from '../index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function testProgram() {
  return new commander.Command()
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} });
}

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

test('optionValueSources: returns an empty object when no option has a value', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--alpha'));
  program.parse(['node', 'test']);
  assert.deepEqual(program.optionValueSources(), {});
});

test('optionValueSources: reports cli for an option given on the command line', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--alpha'));
  program.parse(['node', 'test', '--alpha']);
  assert.deepEqual(program.optionValueSources(), { alpha: 'cli' });
});

test('optionValueSources: reports default for an option with only a default', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--alpha <a>').default('d'));
  program.parse(['node', 'test']);
  assert.deepEqual(program.optionValueSources(), { alpha: 'default' });
});

test('optionValueSources: reports cli once a defaulted option is given explicitly', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--alpha <a>').default('d'));
  program.parse(['node', 'test', '--alpha', 'given']);
  assert.deepEqual(program.optionValueSources(), { alpha: 'cli' });
});

test('optionValueSources: reports each option separately', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--alpha <a>').default('d'));
  program.addOption(new commander.Option('--beta'));
  program.parse(['node', 'test', '--beta']);
  assert.deepEqual(program.optionValueSources(), {
    alpha: 'default',
    beta: 'cli',
  });
});

test('optionValueSources: uses the camelCase attribute name as the key', () => {
  const program = testProgram();
  program.addOption(new commander.Option('--dry-run'));
  program.parse(['node', 'test', '--dry-run']);
  assert.deepEqual(program.optionValueSources(), { dryRun: 'cli' });
});

test('optionValueSources: typings declare Command.optionValueSources()', () => {
  assert.match(
    typingsClassBlock('Command'),
    /^\s*optionValueSources\(\s*\)\s*:/m,
  );
});
