// Import policy into a NEW home. Source loaders are read-only: no jobs, connections or keys carry over.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadEffectiveOwnerWorkers, parseWorkers, updateWorkerRepoPolicy, workerRepoMigrationFile } from './workers.mjs';

function reenrollmentIntent(files, workers) {
  const subscriptions = [], destinationApprovals = [];
  for (const file of files) {
    const db = new DatabaseSync(path.resolve(file), { readOnly: true });
    try {
      const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      if (hasTable('subscriptions')) {
        // Never select encrypted connection/secret columns. Callback paths and queries can also contain credentials.
        const hasExpiry = db.prepare("SELECT 1 FROM pragma_table_info('subscriptions') WHERE name='expires_at'").get();
        const rows = hasExpiry
          ? db.prepare("SELECT worker,url,count(*) count FROM subscriptions WHERE state='active' AND expires_at>? GROUP BY worker,url").all(new Date().toISOString())
          : db.prepare("SELECT worker,url,count(*) count FROM subscriptions WHERE state='active' GROUP BY worker,url").all();
        for (const row of rows) {
          if (!Object.hasOwn(workers, row.worker)) throw new Error(`subscription refers to unknown worker ${row.worker}`);
          let callbackOrigin = null;
          try { const url = new URL(row.url); if (['https:', 'http:'].includes(url.protocol)) callbackOrigin = url.origin; } catch { /* manual re-enrolment required */ }
          const old = subscriptions.find(item => item.worker === row.worker && item.callback_origin === callbackOrigin);
          if (old) old.count += Number(row.count);
          else subscriptions.push({ worker: row.worker, callback_origin: callbackOrigin, count: Number(row.count), action: 'reconnect_then_events_subscribe' });
        }
      }
      if (hasTable('destination_approvals')) {
        for (const row of db.prepare("SELECT json_extract(snapshot,'$.worker') worker,count(*) count FROM destination_approvals GROUP BY json_extract(snapshot,'$.worker')").all()) {
          if (!Object.hasOwn(workers, row.worker)) throw new Error(`destination approval refers to unknown worker ${row.worker}`);
          const old = destinationApprovals.find(item => item.worker === row.worker);
          if (old) old.count += Number(row.count);
          else destinationApprovals.push({ worker: row.worker, count: Number(row.count), action: 'review_new_destination_revision_on_each_new_job' });
        }
      }
    } finally { db.close(); }
  }
  return { subscriptions, destination_approvals: destinationApprovals };
}

export function migrateWorkers({ home, sources, sourceDbs = [], workspaceWorkers = [] }) {
  if (!home || !Array.isArray(sources) || !sources.length) throw new Error('--home and at least one --source workers.json are required');
  if (!Array.isArray(sourceDbs) || !Array.isArray(workspaceWorkers)) throw new Error('sourceDbs and workspaceWorkers must be arrays');
  home = path.resolve(home);
  const workers = {};
  const grants = new Map();
  const deniedRepositories = [];
  for (const source of sources) {
    const file = path.resolve(source);
    if (!fs.existsSync(file) && !fs.existsSync(workerRepoMigrationFile(file))) throw new Error(`no worker policy at ${file}`);
    const profile = loadEffectiveOwnerWorkers(file);
    deniedRepositories.push(...profile.deniedRepoGrants.map(item => ({ source: file, ...item })));
    for (const [name, worker] of profile.workers) {
      if (Object.hasOwn(workers, name)) throw new Error(`duplicate worker ${name} in sources`);
      workers[name] = {
        repos: [],
        workspaceAllowed: worker.workspaceAllowed === true || workspaceWorkers.includes(name),
        ...(worker.capabilities.size ? { capabilities: [...worker.capabilities] } : {}),
        ...(worker.guidance ? { guidance: worker.guidance } : {}),
        ...(worker.destination ? { destination: worker.destination } : {}),
      };
      grants.set(name, profile.repoPolicy(name).repos);
    }
  }
  for (const name of workspaceWorkers) if (!Object.hasOwn(workers, name)) throw new Error(`unknown workspace worker ${name}`);
  const value = { workers, default_execution: 'none' };
  parseWorkers(value, { builtin: true });
  const intent = reenrollmentIntent(sourceDbs, workers);
  const manifest = {
    schema_version: 1, authoritative: false, ...intent,
    required_actions: [
      'Pair and approve every connector in the new home; old connections and tokens are not valid here.',
      'Each connector must call events/subscribe again with its callback and a fresh signing key; callback paths and credentials were omitted.',
      'Review the new destination disclosure and approve its current destination_revision when submitting each new job; old approvals bind old jobs and connections.',
    ],
  };
  // mkdir without recursive fails for any existing destination, including symlinks and empty homes.
  fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  const config = path.join(home, '.config/dalan');
  const workersFile = path.join(config, 'workers.json');
  const manifestFile = path.join(config, 'service-migration.json');
  try {
    fs.mkdirSync(config, { recursive: true, mode: 0o700 });
    fs.writeFileSync(workersFile, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    for (const [name, repos] of grants) for (const repo of repos) updateWorkerRepoPolicy(workersFile, name, 'allow', repo);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return { home, workers_file: workersFile, migration_manifest: manifestFile,
    workers: [...grants].map(([worker, repos]) => ({ worker, repos, workspaceAllowed: workers[worker].workspaceAllowed })),
    default_execution: 'none', reenrollment_required: true, denied_repositories: deniedRepositories };
}

export function migrationMain(args = process.argv.slice(4)) {
  let home;
  let json = false;
  const sources = [], sourceDbs = [], workspaceWorkers = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') { json = true; continue; }
    if (!['--home', '--source', '--source-db', '--workspace-worker'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid migration option ${args[i]}`);
    const option = args[i++];
    if (option === '--home') { if (home) throw new Error('duplicate --home'); home = args[i]; }
    else if (option === '--source') sources.push(args[i]);
    else if (option === '--source-db') sourceDbs.push(args[i]);
    else workspaceWorkers.push(args[i]);
  }
  const result = migrateWorkers({ home, sources, sourceDbs, workspaceWorkers });
  process.stdout.write(json ? JSON.stringify(result) + '\n' : `Created ${result.workers.length} workers in ${result.home}; execution defaults to none. Re-enrol connectors, subscriptions and destination approvals using ${result.migration_manifest}. No sign-ins or jobs were copied.${result.denied_repositories.length ? ` Denied unaudited additions: ${result.denied_repositories.map(item => `${item.worker}: ${item.repos.join(', ')}`).join('; ')}.` : ''}\n`);
  return result;
}
