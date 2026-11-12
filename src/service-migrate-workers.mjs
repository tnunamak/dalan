// Import policy into a NEW home. Source loaders are read-only: no jobs, connections or keys carry over.
import fs from 'node:fs';
import path from 'node:path';
import { loadOwnerWorkers, parseWorkers, updateWorkerRepoPolicy, workerRepoMigrationFile } from './workers.mjs';

export function migrateWorkers({ home, sources }) {
  if (!home || !Array.isArray(sources) || !sources.length) throw new Error('--home and at least one --source workers.json are required');
  home = path.resolve(home);
  const workers = {};
  const grants = new Map();
  for (const source of sources) {
    const file = path.resolve(source);
    // Older single-worker homes have a repos-only migration journal instead of workers.json.
    // Do not infer grants from a queue or read any database in the source home.
    if (!fs.existsSync(file) && !fs.existsSync(workerRepoMigrationFile(file))) throw new Error(`no worker policy at ${file}`);
    const profile = loadOwnerWorkers(file);
    for (const [name, worker] of profile.workers) {
      if (Object.hasOwn(workers, name)) throw new Error(`duplicate worker ${name} in sources`);
      workers[name] = { repos: [], ...(worker.capabilities.size ? { capabilities: [...worker.capabilities] } : {}), ...(worker.guidance ? { guidance: worker.guidance } : {}) };
      grants.set(name, profile.repoPolicy(name).repos);
    }
  }
  const value = { workers, default_execution: 'none' };
  parseWorkers(value, { builtin: true });
  // mkdir without recursive fails for any existing destination, including symlinks and empty homes.
  fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  const config = path.join(home, '.config/dalan');
  const workersFile = path.join(config, 'workers.json');
  try {
    fs.mkdirSync(config, { recursive: true, mode: 0o700 });
    fs.writeFileSync(workersFile, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    // Record each copied grant as a new approval in this home, rather than copying the old audit or tokens.
    for (const [name, repos] of grants) for (const repo of repos) updateWorkerRepoPolicy(workersFile, name, 'allow', repo);
  } catch (error) {
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return { home, workers_file: workersFile, workers: [...grants].map(([worker, repos]) => ({ worker, repos })), default_execution: 'none' };
}

export function migrationMain(args = process.argv.slice(4)) {
  let home;
  let json = false;
  const sources = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') { json = true; continue; }
    if (!['--home', '--source'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid migration option ${args[i]}`);
    const option = args[i++];
    if (option === '--home') { if (home) throw new Error('duplicate --home'); home = args[i]; }
    else sources.push(args[i]);
  }
  const result = migrateWorkers({ home, sources });
  process.stdout.write(json ? JSON.stringify(result) + '\n' : `Created ${result.workers.length} workers in ${result.home}; execution defaults to none. No sign-ins or jobs were copied.\n`);
  return result;
}
