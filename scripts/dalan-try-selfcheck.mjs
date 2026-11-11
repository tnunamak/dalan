#!/usr/bin/env node
// Run against a live `dalan try --public` trial before adding the connector in claude.ai or ChatGPT:
//   node scripts/dalan-try-selfcheck.mjs --home <trial home> [--client claude|chatgpt] [--wait 300]
// The trial's authorization server must be on its public origin: a constraint of the trial, not of OAuth.
// It acts as a real OAuth client and waits for you to approve the connection (y) in the trial terminal.
import fs from 'node:fs';
import path from 'node:path';
import { runSelfCheck } from '../src/try-selfcheck.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const home = option('--home'), client = option('--client') ?? 'claude', wait = Number(option('--wait') ?? 300);
let url = process.env.DALAN_TRY_URL;
if (!url && home) { try { url = fs.readFileSync(path.join(home, 'resource-url'), 'utf8').trim(); } catch { /* reported below */ } }
if (!url || !['claude', 'chatgpt'].includes(client)) {
  process.stderr.write('usage: node scripts/dalan-try-selfcheck.mjs --home <trial home> [--client claude|chatgpt] [--wait seconds]\n(or set DALAN_TRY_URL to the trial\'s MCP URL; it is a credential, so it is never taken from an argument)\n');
  process.exit(2);
}
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  const { ok } = await runSelfCheck({ url, client, approveWaitMs: wait * 1000, signal: controller.signal, say: line => process.stdout.write(`${line}\n`) });
  process.exit(ok ? 0 : 1);
} catch {
  // The error text can hold the credential URL, so none of it is printed.
  process.stdout.write('FAIL self-check: stopped before it finished (cancelled or an unexpected error)\nRESULT FAIL\n');
  process.exit(1);
}
