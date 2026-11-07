#!/usr/bin/env node
// The README "Your own first job" commands take the reader's task as typed text. The shell must not run or expand
// anything in it, and `dalan submit --brief` must receive it exactly. A stub `dalan` on PATH records its arguments.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const section = readme.slice(readme.indexOf('<a id="your-own-first-job"></a>'));
const blocks = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map(m => m[1]).slice(0, 2);

function hasShell(name) {
  return spawnSync(name, ['-c', 'exit 0']).status === 0;
}

function runSnippet(shell, { submitStatus = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-first-job-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const stub = path.join(bin, 'dalan');
    // The stub writes each argument followed by a NUL byte, so the test sees argument boundaries exactly.
    fs.writeFileSync(stub, `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > '${path.join(dir, 'argv.bin')}'\nexit ${submitStatus}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const pwned = [path.join(dir, 'PWNED1'), path.join(dir, 'PWNED2')];
    const task = `  Explain \`touch ${pwned[0]}\` and $(touch ${pwned[1]}) "quoted" $HOME back\\slash and a 'single' quote.  `;
    // `read` takes the next input line, as when the reader types the task after the first block.
    const input = `${blocks[0]}${task}\n${blocks[1]}`;
    const result = spawnSync(shell, ['-s'], {
      input, encoding: 'utf8', cwd: dir,
      env: { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`, HOME: dir },
    });
    const argv = fs.existsSync(path.join(dir, 'argv.bin')) ? fs.readFileSync(path.join(dir, 'argv.bin'), 'utf8').split('\0').slice(0, -1) : null;
    return { result, argv, task, ran: pwned.filter(f => fs.existsSync(f)) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('the README section has the two command blocks this test runs', () => {
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /IFS= read -r task/);
  assert.match(blocks[1], /dalan submit .*--brief "\$task /);
  assert.doesNotMatch(blocks.join(''), /<<\s*EOF/, 'no unquoted here-document may carry the task');
});

for (const shell of ['bash', 'zsh']) {
  test(`${shell}: the typed task is submitted as text and nothing in it runs`, { skip: !hasShell(shell) && `${shell} not installed` }, () => {
    const { result, argv, task, ran } = runSnippet(shell);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(ran, [], 'a command in the task ran in the shell');
    assert.ok(argv, 'dalan submit was not run');
    assert.deepEqual(argv.slice(0, 7), ['submit', '--worker', 'local', '--execution', 'none', '--deliver', 'none']);
    assert.equal(argv[7], '--brief');
    assert.equal(argv[8], `${task} Do not read files, run commands or call external services.`);
    assert.equal(argv.length, 9);
  });
}
