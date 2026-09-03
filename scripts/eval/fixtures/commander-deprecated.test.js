// eval-deprecated.test.js  --  EVAL FEATURE SPEC (not part of the commander baseline suite)
//
// Feature (A of three): Option.deprecated(message) — record a deprecation, warn on use, and
// surface it in help. Touches lib/option.js, lib/command.js, lib/help.js and typings/index.d.ts.
//
// This file is seeded by TWO tasks, byte-identical in both, on purpose:
//   commander-audit-trio       all three features in ONE prompt (long-horizon)
//   commander-continuity       the same three features as THREE prompts in one session (H25)
// Same oracle bytes in both means the pair is a clean A/B on prompt shape rather than on
// difficulty, which is what makes "does splitting the work into turns help?" answerable.
//
// FLAT test() calls, no describe(): Node's TAP nests describe blocks, which collapses the
// eval's per-case granularity to one result per suite and destroys partial credit.

import { readFileSync } from 'node:fs';
import * as commander from '../index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function captureProgram() {
  const errors = [];
  const program = new commander.Command()
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: (s) => errors.push(s) });
  return { program, errors };
}

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

test('deprecated: builder returns the option for chaining', () => {
  const option = new commander.Option('--old');
  assert.equal(option.deprecated('use --new'), option);
});

test('deprecated: the message is recorded on the option', () => {
  const option = new commander.Option('--old').deprecated('use --new');
  assert.equal(option.deprecatedMessage, 'use --new');
});

test('deprecated: deprecatedMessage is undefined by default', () => {
  const option = new commander.Option('--old');
  assert.equal(option.deprecatedMessage, undefined);
});

test('deprecated: no warning when the option is not used', () => {
  const { program, errors } = captureProgram();
  program.addOption(new commander.Option('--old').deprecated('use --new'));
  program.parse(['node', 'test']);
  assert.deepEqual(errors, []);
});

test('deprecated: a warning is written to stderr when the option is used', () => {
  const { program, errors } = captureProgram();
  program.addOption(new commander.Option('--old').deprecated('use --new'));
  program.parse(['node', 'test', '--old']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0], "warning: option '--old' is deprecated: use --new\n");
});

test('deprecated: using the option still sets its value normally', () => {
  const { program } = captureProgram();
  program.addOption(new commander.Option('--old').deprecated('use --new'));
  program.parse(['node', 'test', '--old']);
  assert.equal(program.opts().old, true);
});

test('deprecated: the warning is not an error and parsing continues', () => {
  const { program, errors } = captureProgram();
  program.addOption(new commander.Option('--old <v>').deprecated('use --new'));
  program.parse(['node', 'test', '--old', 'value']);
  assert.equal(program.opts().old, 'value');
  assert.equal(errors.length, 1);
});

test('deprecated: help description reports the deprecation', () => {
  const option = new commander.Option('--old', 'the old way').deprecated(
    'use --new',
  );
  const helper = new commander.Help();
  assert.equal(
    helper.optionDescription(option),
    'the old way (deprecated: use --new)',
  );
});

test('deprecated: typings declare Option.deprecated() returning this', () => {
  assert.match(
    typingsClassBlock('Option'),
    /^\s*deprecated\(\s*message\s*:\s*string\s*\)\s*:\s*this\s*;/m,
  );
});
