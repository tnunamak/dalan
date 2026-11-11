#!/usr/bin/env node
// Run against a live `dalan try --public` trial before adding the connector in claude.ai or ChatGPT:
//   node scripts/dalan-try-selfcheck.mjs --home <trial home> [--client claude|chatgpt] [--wait 300]
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
const { ok } = await runSelfCheck({ url, client, approveWaitMs: wait * 1000, say: line => process.stdout.write(`${line}\n`) });
process.exit(ok ? 0 : 1);
