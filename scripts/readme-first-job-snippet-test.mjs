#!/usr/bin/env node
// Execute the README's first submission with a stub CLI, preserving its argument boundaries.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const heading = '## Give your connected agent a job';
const start = readme.indexOf(heading);
const section = start < 0 ? '' : readme.slice(start + heading.length).split('\n## ')[0];
const block = [...section.matchAll(/```sh\n([\s\S]*?)```/g)][0]?.[1];
const brief = block?.match(/--brief "([^"\n]+)"/)?.[1];

function hasShell(name) {
  return spawnSync(name, ['-c', 'exit 0']).status === 0;
}

function runSnippet(shell) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-first-job-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const stub = path.join(bin, 'dalan');
    // NUL separators retain argument boundaries, including the brief's spaces.
    fs.writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > '${path.join(dir, 'argv.bin')}'\n`, { mode: 0o755 });
    const result = spawnSync(shell, ['-s'], {
      input: block, encoding: 'utf8', cwd: dir,
      env: { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`, HOME: dir },
    });
    const argv = fs.existsSync(path.join(dir, 'argv.bin')) ? fs.readFileSync(path.join(dir, 'argv.bin'), 'utf8').split('\0').slice(0, -1) : null;
    return { result, argv };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('the README first-job section has one explicit submission command', () => {
  assert.ok(start >= 0, 'first-job section is missing');
  assert.match(block ?? '', /^dalan submit /);
  assert.ok(brief, 'the brief must be one nonempty quoted argument');
});

for (const shell of ['bash', 'zsh']) {
  test(`${shell}: the published first-job command preserves the CLI arguments`, { skip: !hasShell(shell) && `${shell} not installed` }, () => {
    const { result, argv } = runSnippet(shell);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(argv, ['submit', '--worker', 'WORKER', '--execution', 'none', '--deliver', 'none', '--brief', brief]);
  });
}
