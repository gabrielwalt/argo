// eval-argument-env.test.js  --  EVAL FEATURE SPEC (not part of the commander baseline suite)
//
// Feature (B of three): Argument.env(name) — a positional argument may take its value from an
// environment variable when it is omitted on the command line. Option.env() already exists
// (lib/option.js, typings/index.d.ts:164); Argument has no equivalent. Touches
// lib/argument.js, lib/command.js (_processArguments) and lib/help.js (argumentDescription).
//
// Seeded by both commander-audit-trio (one prompt) and commander-continuity (turn 2 of three),
// byte-identical, so the pair is an A/B on prompt shape rather than on difficulty.
//
// Every test that sets an environment variable uses a name unique to that test and deletes it
// in a `finally`, because node --test runs files in separate processes but tests within a file
// share one process, and a leaked variable would make a later test pass for the wrong reason.
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

test('argument env: builder returns the argument for chaining', () => {
  const argument = new commander.Argument('<thing>');
  assert.equal(argument.env('EVAL_TRIO_CHAIN'), argument);
});

test('argument env: the name is recorded on the argument', () => {
  const argument = new commander.Argument('<thing>').env('EVAL_TRIO_NAME');
  assert.equal(argument.envVar, 'EVAL_TRIO_NAME');
});

test('argument env: envVar is undefined by default', () => {
  const argument = new commander.Argument('<thing>');
  assert.equal(argument.envVar, undefined);
});

test('argument env: the value comes from the environment when the argument is omitted', () => {
  process.env.EVAL_TRIO_FROM_ENV = 'from-env';
  try {
    const program = testProgram();
    let received;
    program
      .addArgument(new commander.Argument('[thing]').env('EVAL_TRIO_FROM_ENV'))
      .action((thing) => {
        received = thing;
      });
    program.parse(['node', 'test']);
    assert.equal(received, 'from-env');
  } finally {
    delete process.env.EVAL_TRIO_FROM_ENV;
  }
});

test('argument env: a command-line value wins over the environment', () => {
  process.env.EVAL_TRIO_CLI_WINS = 'from-env';
  try {
    const program = testProgram();
    let received;
    program
      .addArgument(new commander.Argument('[thing]').env('EVAL_TRIO_CLI_WINS'))
      .action((thing) => {
        received = thing;
      });
    program.parse(['node', 'test', 'from-cli']);
    assert.equal(received, 'from-cli');
  } finally {
    delete process.env.EVAL_TRIO_CLI_WINS;
  }
});

test('argument env: the default value is used when neither cli nor environment supplies one', () => {
  delete process.env.EVAL_TRIO_UNSET;
  const program = testProgram();
  let received;
  program
    .addArgument(
      new commander.Argument('[thing]')
        .default('fallback')
        .env('EVAL_TRIO_UNSET'),
    )
    .action((thing) => {
      received = thing;
    });
  program.parse(['node', 'test']);
  assert.equal(received, 'fallback');
});

test('argument env: the environment wins over the default value', () => {
  process.env.EVAL_TRIO_OVER_DEFAULT = 'from-env';
  try {
    const program = testProgram();
    let received;
    program
      .addArgument(
        new commander.Argument('[thing]')
          .default('fallback')
          .env('EVAL_TRIO_OVER_DEFAULT'),
      )
      .action((thing) => {
        received = thing;
      });
    program.parse(['node', 'test']);
    assert.equal(received, 'from-env');
  } finally {
    delete process.env.EVAL_TRIO_OVER_DEFAULT;
  }
});

test('argument env: help description reports the environment variable', () => {
  const argument = new commander.Argument('<thing>', 'a thing').env(
    'EVAL_TRIO_HELP',
  );
  const helper = new commander.Help();
  assert.equal(
    helper.argumentDescription(argument),
    'a thing (env: EVAL_TRIO_HELP)',
  );
});

test('argument env: typings declare Argument.env() returning this', () => {
  assert.match(
    typingsClassBlock('Argument'),
    /^\s*env\(\s*name\s*:\s*string\s*\)\s*:\s*this\s*;/m,
  );
});
