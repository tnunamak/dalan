import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runBuildProseCheck } from '../src/acp-bridge.mjs';

test('failed descendant inspection retains the checker home and reports cleanup debt', async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'prose-inspection-'));
  let home;
  try {
    const checker = path.join(root, 'checker.mjs');
    fs.writeFileSync(checker, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({findings:[{text:process.env.HOME}]})));\n`, { mode: 0o700 });
    const result = await runBuildProseCheck('acme/repo', '+++ b/README.md\n+Hello.\n', { DALAN_ACP_PROSE_CHECK_OWNERS: 'acme', DALAN_ACP_PROSE_CHECK: checker }, { refusal: () => null, descendants() { throw new Error('injected process inspection failure'); } });
    home = result.findings?.[0]?.text;
    assert.equal(result.status, 'ERROR');
    assert.match(result.detail, /inspection.*retained/i);
    home = result.cleanupHome;
    assert.ok(fs.statSync(home).isDirectory(), 'unknown descendants may still use this home');
  } finally {
    if (home && path.basename(home).startsWith('prose-check-')) fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
