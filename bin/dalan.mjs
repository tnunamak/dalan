#!/usr/bin/env node
// `dalan try` runs before the CLI loads: it picks its own trial home. For every other command, DALAN_HOME names the
// bridge home. Setting HOME here, after Node has started, keeps version-manager shims working.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unsupportedRuntime } from '../src/runtime-check.mjs';
import { followTarget, handOver } from '../src/follow-current.mjs';
import { readDefaultHome } from '../src/default-home.mjs';
import { resolveHelp } from '../src/cli-help.mjs';
// Follow the version the service runs, so the CLI and the service never drift. Then find the recorded home without DALAN_HOME.
const followed = followTarget({ ownBin: fileURLToPath(import.meta.url) });
if (followed) handOver(followed);
else {
if (!process.env.DALAN_HOME && !['try', 'service', 'setup'].includes(process.argv[2])) { const recorded = readDefaultHome(); if (recorded) process.env.DALAN_HOME = recorded; }
if (['--version', '-v'].includes(process.argv[2])) {
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
// Before any import that needs Node 24 (node:sqlite): an unsupported Node or platform gets one line, not a stack trace.
const unsupported = unsupportedRuntime();
if (unsupported) { process.stderr.write(`dalan: ${unsupported}\n`); process.exit(1); }
// Help requests, no command and unknown commands are answered here, before the trial-home guard and the CLI load.
const help = resolveHelp(process.argv.slice(2));
if (help) {
  (help.stream === 'stdout' ? process.stdout : process.stderr).write(`${help.text}\n`);
  process.exitCode = help.code;
} else if (process.argv[2] === 'mcp') {
  // stdout is the protocol channel: nothing else may print to it. The tools run the CLI, which applies the DALAN_HOME rules.
  await (await import('../src/mcp-stdio.mjs')).main();
} else if (process.argv[2] === 'setup') {
  await (await import('../src/setup.mjs')).main();
} else if (process.argv[2] === 'service') {
  try { await (await import('../src/service.mjs')).serviceMain(process.argv.slice(3)); }
  catch (error) { process.stderr.write(`dalan: service: ${error.message}\n`); process.exitCode = 1; }
} else if (process.argv[2] === 'try') {
  await (await import('../src/try.mjs')).main();
} else {
  const command = process.argv[2];
  const trial = path.join(os.homedir(), '.local/share/dalan-trial');
  // doctor is exempt: it diagnoses a missing bridge home and reports it as a finding.
  if (!process.env.DALAN_HOME && command && !['help', '--help', '-h', 'paths', 'doctor'].includes(command) && fs.existsSync(path.join(trial, '.dalan-trial'))) {
    const message = `DALAN_HOME is not set, so "dalan ${command}" does not know which bridge home to use. To use the trial bridge, run this, then run the command again:\n  export DALAN_HOME='${trial.replaceAll("'", "'\\''")}'`;
    process.stderr.write(process.argv.includes('--json') ? `${JSON.stringify({ error: message, kind: 'local' })}\n` : `dalan: ${message}\n`);
    process.exit(1);
  }
  if (process.env.DALAN_HOME) process.env.HOME = path.resolve(process.env.DALAN_HOME);
  await import('./dot-worker.mjs');
}
}
