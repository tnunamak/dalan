#!/usr/bin/env node
import { readEnv } from '../src/env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeadmanFromEnv, readDeadmanStatus } from '../src/deadman.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('dalan-deadman requires Node 24+');

const [command = 'serve', ...args] = process.argv.slice(2);
const envFile = process.env.DOT_DEADMAN_ENV || path.join(os.homedir(), '.config/dot-deadman/env');

function loadEnv() {
  if (!fs.existsSync(envFile)) return;
  if ((fs.statSync(envFile).mode & 0o777) !== 0o600) throw new Error('dead-man env file must be mode 0600');
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const match = line.replace(/\r$/, '').match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else if (value.startsWith('"') || value.startsWith("'")) throw new Error('malformed quoted value in dead-man env file');
      process.env[match[1]] = value;
    }
  }
}

async function heartbeat() {
  const file = readEnv('DALAN_HEALTH_FILE');
  const url = process.env.DOT_DEADMAN_URL;
  const token = process.env.DOT_DEADMAN_TOKEN;
  if (!file || !url || !token) throw new Error('heartbeat requires health file, URL, and bearer token');
  if (token.length < 32 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token)) throw new Error('heartbeat bearer token must contain at least 32 valid bearer characters');
  const target = new URL(url);
  if (target.username || target.password) throw new Error('heartbeat URL must not contain credentials');
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname))) throw new Error('remote heartbeat URL must use HTTPS');
  if (target.search || target.hash) throw new Error('heartbeat base URL cannot include a query or fragment');
  const health = JSON.parse(fs.readFileSync(file, 'utf8'));
  const observed = Date.parse(health.observed_at);
  if (health.healthy !== true || !Number.isFinite(observed) || Date.now() - observed > 90_000 || observed > Date.now() + 30_000) {
    throw new Error('bridge health evidence is absent, unhealthy, or stale');
  }
  target.pathname = `${target.pathname.replace(/\/+$/, '')}/heartbeat`;
  const response = await fetch(target, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ healthy: true }), redirect: 'error', signal: AbortSignal.timeout(5000)
  });
  if (response.status !== 202) throw new Error(`heartbeat rejected with HTTP ${response.status}`);
  console.log('heartbeat accepted');
}

try {
  loadEnv();
  if (command === 'heartbeat') await heartbeat();
  else if(command==='status') {
    if(args.length)throw new Error('usage: dalan-deadman status');
    const dbFile=process.env.DOT_DEADMAN_DB||'/var/lib/dot-deadman/deadman.sqlite';
    console.log(JSON.stringify(readDeadmanStatus(dbFile),null,2));
  }
  else if(command==='reconcile') {
    if(args.length!==5||!['initial','reminder'].includes(args[1])||!['sent','unsent'].includes(args[2])||args[3]!=='--evidence')
      throw new Error('usage: dalan-deadman reconcile EPISODE initial|reminder sent|unsent --evidence RECEIPT');
    const episodeId=Number(args[0]);
    const port=Number(process.env.DOT_DEADMAN_PORT||8788);
    if(!Number.isInteger(port)||port<1||port>65535)throw new Error('invalid dead-man service port');
    const response=await fetch(`http://127.0.0.1:${port}/reconcile`,{
      method:'POST',headers:{Authorization:`Bearer ${process.env.DOT_DEADMAN_TOKEN||''}`,'Content-Type':'application/json'},
      body:JSON.stringify({episodeId,phase:args[1],outcome:args[2],receipt:args[4]}),signal:AbortSignal.timeout(5000)
    });
    if(!response.ok)throw new Error(response.status===409?'owning publisher has not settled this publication':'owning dead-man service is unavailable');
    console.log(JSON.stringify(await response.json()));
  }
  else if (command === 'serve') {
    const monitor = createDeadmanFromEnv();
    const address = await monitor.start({ host: process.env.DOT_DEADMAN_HOST || '127.0.0.1', port: Number(process.env.DOT_DEADMAN_PORT || 8788) });
    console.log(`dead-man listening on ${typeof address === 'object' ? `${address.address}:${address.port}` : address}`);
    const stop = async () => { await monitor.close(); process.exit(0); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } else throw new Error('usage: dalan-deadman [serve|heartbeat|status|reconcile]');
} catch (error) {
  console.error(`dalan-deadman: ${error.message}`);
  process.exitCode = 1;
}
