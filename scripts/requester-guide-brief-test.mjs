#!/usr/bin/env node
// The local-agent requester guide tells an agent how to put a user's brief on the `dalan submit` command line. Follow its
// template and its quoting rule with a stub CLI: the brief must arrive as one literal argument, and nothing in it may run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const guide = fs.readFileSync(new URL('../docs/local-agent-requester.md', import.meta.url), 'utf8');
const template = guide.match(/^1\. Run: (dalan submit .*)$/m)?.[1];
// The guide's worked example: "the brief X becomes --brief '...'".
const example = guide.match(/for example, the brief (.+?) becomes (--brief '.*?')\)/);
// What the guide tells the agent to do with a single quote inside the brief.
const quote = text => text.replaceAll("'", "'\\''");

function hasShell(name) { return spawnSync(name, ['-c', 'exit 0']).status === 0; }

function run(shell, command) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requester-brief-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // NUL separators keep argument boundaries, including spaces and newlines in the brief.
    fs.writeFileSync(path.join(bin, 'dalan'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > '${path.join(dir, 'argv.bin')}'\n`, { mode: 0o755 });
    const result = spawnSync(shell, ['-s'], { input: `${command}\n`, encoding: 'utf8', cwd: dir,
      env: { PATH: `${bin}${path.delimiter}/usr/bin:/bin`, HOME: dir } });
    const argv = fs.existsSync(path.join(dir, 'argv.bin')) ? fs.readFileSync(path.join(dir, 'argv.bin'), 'utf8').split('\0').slice(0, -1) : null;
    return { result, argv, ran: fs.existsSync(path.join(dir, 'ran')) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('the guide gives one submit template with a TEXT placeholder, the quoting rule and a worked example', () => {
  assert.ok(template, 'step 1 has no `dalan submit` command');
  assert.equal(template.split('TEXT').length, 2, 'the template has exactly one TEXT placeholder');
  assert.ok(guide.includes("'\\''"), 'the guide names the escape for a single quote');
  assert.ok(example, 'the guide has a worked quoting example');
});

const hostile = "It's $(touch ran) and `touch ran` and \"quoted\" and $HOME\non two lines";
for (const shell of ['sh', 'bash', 'zsh']) {
  test(`${shell}: a brief put into the template by the guide's rule arrives literally and runs nothing`, { skip: !hasShell(shell) && `${shell} not installed` }, () => {
    const { result, argv, ran } = run(shell, template.replace('TEXT', quote(hostile)));
    assert.equal(ran, false, 'a command substitution in the brief ran');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(argv, ['submit', '--worker', 'WORKER', '--execution', 'none', '--deliver', 'none', '--brief', hostile, '--json']);
  });
  test(`${shell}: the guide's worked example passes its brief literally`, { skip: !hasShell(shell) && `${shell} not installed` }, () => {
    const { result, argv } = run(shell, `dalan submit ${example[2]}`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(argv, ['submit', '--brief', example[1]]);
  });
}
