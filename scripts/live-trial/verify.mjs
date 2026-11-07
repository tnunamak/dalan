#!/usr/bin/env node
import { defaultPath } from '../../src/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  dotJson,
  mcpRpc,
  mcpTool,
  parseArgs,
  readJobs,
  readManifest,
  readStdin,
} from './common.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['--home'],
  flags: ['--token-stdin'],
});

function expect(condition, message) { if (!condition) throw new Error(message); }

async function checkWorkerApi(manifest, jobs, token) {
  const listed = await mcpRpc(manifest, token, 'tools/list');
  expect(listed.status === 200, 'worker tools/list did not return HTTP 200');
  const names = listed.body?.result?.tools?.map(tool => tool.name) ?? [];
  expect(names.length > 0, 'worker tools/list returned no tools');
  expect(!names.some(name => /^t3_|^notify_owner$/.test(name)), 'fixture-a tools/list includes a T3 tool');

  const pending = await mcpTool(manifest, token, 'list_pending');
  expect(pending.status === 200 && !pending.isError, 'worker list_pending failed');
  expect(!pending.value?.assignments?.some(item => item.request_id === jobs.dot_request_id), 'fixture-a can see the worker control job');

  const crossClaim = await mcpTool(manifest, token, 'claim', {
    request_id: jobs.dot_request_id,
    claimant: manifest.worker,
  });
  expect(crossClaim.status === 200 && crossClaim.isError, 'fixture-a could claim the worker control job');

  const connection = dotJson(manifest.home, ['connect', 'list', '--json']).connections
    .find(item => item.worker === manifest.worker && item.revoked_at === null);
  expect(connection, 'active fixture-a connection disappeared before the unknown-worker probe');
  const databasePath = defaultPath(manifest.home,'.config/dot-bridge/as.sqlite');
  const db = new DatabaseSync(databasePath);
  let grantId;
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const row = db.prepare('SELECT grant_id FROM connections WHERE connection_id=?').get(connection.connection_id);
    grantId = row?.grant_id;
    expect(grantId, 'active connection has no grant row');
    const changed = db.prepare('UPDATE connections SET worker=? WHERE grant_id=?').run('live_trial_missing_worker', grantId);
    expect(Number(changed.changes) === 1, 'could not prepare unknown-worker probe');
  } finally {
    db.close();
  }
  let unknownStatus;
  try {
    unknownStatus = (await mcpRpc(manifest, token, 'tools/list')).status;
  } finally {
    const restore = new DatabaseSync(databasePath);
    try {
      restore.exec('PRAGMA busy_timeout=5000');
      restore.prepare('UPDATE connections SET worker=? WHERE grant_id=?').run(manifest.worker, grantId);
    } finally {
      restore.close();
    }
  }
  expect(unknownStatus === 403, 'a valid token with an unknown worker binding did not return HTTP 403');
  expect((await mcpRpc(manifest, token, 'tools/list')).status === 200, 'connection did not recover after the unknown-worker probe');
  console.log(`PASS worker tools/list has no T3 tools; cross-worker claim denied; unknown worker binding returns 403`);
}

async function main() {
  if (args._.length || !args['--home']) throw new Error('usage: verify.mjs --home DIR [--token-stdin]');
  const manifest = readManifest(path.resolve(args['--home']));
  const jobs = readJobs(manifest);
  const profile = JSON.parse(fs.readFileSync(defaultPath(manifest.home,'.config/dot-bridge/workers.json'), 'utf8'));
  const workerConfig = profile.workers?.[manifest.worker];
  expect(workerConfig && (workerConfig.capabilities === undefined || Array.isArray(workerConfig.capabilities)), 'worker profile is invalid');
  expect(!(workerConfig.capabilities ?? []).includes('t3'), 'fixture-a worker has the T3 capability');
  expect(profile.default_execution === 'none', 'workspace execution is not disabled');

  const connections = dotJson(manifest.home, ['connect', 'list', '--json']).connections;
  const connection = connections.find(item => item.worker === manifest.worker && item.revoked_at === null);
  expect(connection, 'no active connection is bound to the named worker');
  console.log(`PASS active connection is bound to ${manifest.worker}`);

  const worker = dotJson(manifest.home, ['get', jobs.worker_request_id, '--json']);
  expect(worker.target_worker === manifest.worker && worker.status === 'finished', 'worker job is not finished on the named worker');
  expect(worker.claim?.worker === manifest.worker && worker.report?.worker === manifest.worker, 'claim or finish is not attributed to the named worker');
  expect(worker.report?.claim_id === worker.claim?.claim_id, 'finish does not reference the worker claim');
  expect(typeof worker.report?.result === 'string' && worker.report.result.includes(jobs.nonce), 'finish report does not contain the nonce');
  console.log(`PASS worker claim and finish are attributed to ${manifest.worker}; nonce is present`);

  const control = dotJson(manifest.home, ['get', jobs.dot_request_id, '--json']);
  expect(control.target_worker === 'dot' && control.status === 'queued' && !control.claim,
    `worker control job changed (target=${control.target_worker}, status=${control.status}, claimed=${Boolean(control.claim)})`);
  console.log('PASS worker control job remains queued and unclaimed');

  const profileWorkerCount = Object.keys(profile.workers).filter(name => name !== 'dot').length;
  expect(profileWorkerCount === 1, 'workers.json does not contain exactly one worker other than the default worker');
  if (args['--token-stdin']) {
    const token = await readStdin();
    expect(/^[A-Za-z0-9_-]{20,128}$/.test(token), 'stdin did not contain one opaque access token');
    await checkWorkerApi(manifest, jobs, token);
  } else {
    console.log('PASS worker config has no T3 capability; live tools/list requires a token held by the connector');
  }
}

main().catch(error => {
  console.error(`verify failed: ${error.message}`);
  process.exitCode = 1;
});
