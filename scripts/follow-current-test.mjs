import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { followTarget } from '../src/follow-current.mjs';

const scratch = path.join(os.homedir(), '.tmp');
fs.mkdirSync(scratch, { recursive: true });
const home = fs.mkdtempSync(path.join(scratch, 'follow-current-test-'));
try {
  const target = path.join(home, 'current', 'bin', 'dalan.mjs');
  const ownBin = path.join(home, 'installed', 'bin', 'dalan.mjs');
  for (const file of [target, ownBin]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// synthetic entry, never executed\n');
  }
  const env = { DALAN_HOME: home };
  assert.equal(followTarget({ ownBin, env,
    argv: ['status', '--', '--home', "the owner's local check"] }),
  fs.realpathSync(target), 'positional --home must not prevent following current');
  assert.equal(followTarget({ ownBin, env,
    argv: ['status', '--home', "the owner's local check"] }),
  null, 'explicit --home keeps the installed package');
  assert.equal(followTarget({ ownBin, env, argv: ['--home=/x', 'status'] }),
    null, 'explicit --home= keeps the installed package');
  assert.equal(followTarget({ ownBin, env: { ...env, DALAN_NO_FOLLOW: '1' },
    argv: ['status', '--', '--home', "the owner's local check"] }),
  null, 'DALAN_NO_FOLLOW overrides following current');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('follow-current tests passed');
