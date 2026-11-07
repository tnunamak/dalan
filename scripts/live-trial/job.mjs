#!/usr/bin/env node
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  JOBS_FILE,
  dotJson,
  parseArgs,
  readJobs,
  readManifest,
  runDot,
  writeJsonPrivate,
} from './common.mjs';

const args = parseArgs(process.argv.slice(2), {
  values: ['--home', '--worker', '--timeout'],
  flags: ['--submit-only', '--wait-only'],
});

function fail(message) { throw new Error(message); }

function submit(home, worker) {
  const nonce = randomUUID();
  const assignment = requestId => ({
    schema_version: 1,
    request_id: requestId,
    brief: `Text-only bridge trial. Do not execute code or contact any service. Echo this nonce in your final finish report: ${nonce}`,
    inputs: [],
    expected_output: `A completed text report that contains nonce ${nonce}.`,
    execution_scope: 'read-only',
  });
  const workerRequestId = `req_fixture-a_${randomUUID()}`;
  const dotRequestId = `req_dot_${randomUUID()}`;
  for (const [requestId, target] of [[workerRequestId, worker], [dotRequestId, 'dot']]) {
    const result = runDot(home, ['submit', '--stdin', '--json', '--worker', target, '--deliver', 'none', '--execution', 'none'], {
      input: JSON.stringify(assignment(requestId)),
      timeout: 30_000,
    });
    if (result.error || result.status !== 0) fail(`submit for ${target} failed`);
    try {
      const response = JSON.parse(result.stdout);
      if (response.duplicate === true) fail(`request id collision for ${target}`);
    } catch (error) {
      if (error.message.includes('request id collision')) throw error;
      fail(`submit for ${target} returned invalid JSON`);
    }
  }

  const jobs = {
    schema_version: 1,
    worker,
    worker_request_id: workerRequestId,
    dot_request_id: dotRequestId,
    nonce,
    submitted_at: new Date().toISOString(),
  };
  writeJsonPrivate(path.join(home, JOBS_FILE), jobs);
  return jobs;
}

function waitForWorker(home, jobs, timeoutSeconds) {
  const waited = runDot(home, ['wait', jobs.worker_request_id, '--timeout', String(timeoutSeconds), '--json'], {
    timeout: (timeoutSeconds + 10) * 1000,
  });
  if (waited.error || ![0, 124].includes(waited.status)) fail('wait for worker job failed');
  const worker = dotJson(home, ['get', jobs.worker_request_id, '--json']);
  const control = dotJson(home, ['get', jobs.dot_request_id, '--json']);
  if (control.target_worker !== 'dot' || control.status !== 'queued' || control.claim) {
    fail('worker control job was claimed, moved or changed target');
  }
  const finished = worker.status === 'finished';
  const echoed = finished && worker.report?.worker === jobs.worker && worker.report?.result?.includes(jobs.nonce) === true;
  console.log(`worker_job=${jobs.worker_request_id} status=${worker.status} nonce_echoed=${echoed ? 'yes' : 'no'}`);
  console.log(`control_job=${jobs.dot_request_id} target=worker status=${control.status} claimed=no`);
  if (finished && !echoed) process.exitCode = 1;
  return { worker, control, echoed };
}

function main() {
  if (args._.length || !args['--home']) fail('usage: job.mjs --home DIR [--worker fixture-a] [--timeout SECONDS] [--submit-only|--wait-only]');
  if (args['--submit-only'] && args['--wait-only']) fail('choose only one of --submit-only and --wait-only');
  const home = path.resolve(args['--home']);
  const manifest = readManifest(home);
  const worker = args['--worker'] ?? manifest.worker;
  if (worker !== manifest.worker) fail('--worker does not match the trial manifest');
  const timeoutSeconds = Number(args['--timeout'] ?? 300);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) fail('--timeout must be between 1 and 3600 seconds');

  let jobs;
  if (args['--wait-only']) {
    jobs = readJobs(manifest);
  } else {
    if (manifest.jobs_file) fail('trial jobs already exist; use --wait-only to read them');
    jobs = submit(home, worker);
    manifest.jobs_file = JOBS_FILE;
    manifest.created_files = [...new Set([...manifest.created_files, JOBS_FILE])].sort();
    writeJsonPrivate(path.join(home, 'live-trial.json'), manifest);
    console.log(`submitted worker_job=${jobs.worker_request_id} control_job=${jobs.dot_request_id}; delivery=none`);
    if (args['--submit-only']) return;
  }
  waitForWorker(home, jobs, timeoutSeconds);
}

try { main(); }
catch (error) {
  console.error(`job failed: ${error.message}`);
  process.exitCode = 1;
}
