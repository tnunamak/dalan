#!/usr/bin/env node
// Submit one read-only review per open PR head that has no worker review yet. Deterministic; see docs/pr-head-reviewer.md.
import { loadConfig, realDeps, run, acquireLock, paths, parseOnly } from '../src/pr-head-reviewer.mjs';

const usage = `usage: dalan-pr-reviewer [--dry-run] [--only OWNER/REPO#N] [--max N] [--ignore-capacity] [--config FILE] [--state-dir DIR]
  --dry-run          print what would be submitted; submit and write nothing
  --only OWNER/REPO#N  consider only that PR (still deduped and gated)
  --max N            submit at most N this run (default: config max_submits_per_run)
  --ignore-capacity  with --dry-run only: preview candidates even when no lane is free`;
const args = process.argv.slice(2), has = f => args.includes(f), opt = f => { const i = args.indexOf(f); return i < 0 ? null : args[i + 1]; };
try {
  const known = new Set(['--dry-run', '--only', '--max', '--ignore-capacity', '--config', '--state-dir', '--help']);
  const values = new Set(['--only', '--max', '--config', '--state-dir']);
  for (let i = 0; i < args.length; i++) { if (!known.has(args[i])) throw new Error(`unknown argument ${args[i]}`); if (values.has(args[i])) i++; }
  if (has('--help')) { console.log(usage); process.exit(0); }
  const dryRun = has('--dry-run');
  if (has('--ignore-capacity') && !dryRun) throw new Error('--ignore-capacity requires --dry-run');
  let only = null;
  // A present --only with a missing or malformed value must fail, never fall through to every open PR.
  if (args.includes('--only')) only = parseOnly(opt('--only'));
  const max = opt('--max') === null ? null : Number(opt('--max'));
  if (max !== null && !(Number.isInteger(max) && max >= 0)) throw new Error('--max expects a non-negative integer');
  const cfg = loadConfig(opt('--config') ?? paths.config), stateDir = opt('--state-dir') ?? paths.stateDir;
  const release = dryRun ? () => {} : acquireLock(stateDir);
  if (!release) { console.error('dalan-pr-reviewer: another run is active'); process.exit(0); }
  try {
    await run({ cfg, deps: realDeps(cfg), stateDir, dryRun, only, maxSubmits: max, ignoreCapacity: has('--ignore-capacity'), print: line => console.log(line) });
  } finally { release(); }
} catch (error) {
  console.error(`dalan-pr-reviewer: ${error.message}`);
  process.exit(1);
}
