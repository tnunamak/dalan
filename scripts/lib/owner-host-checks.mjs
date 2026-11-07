// A host check runs only from an owner-configured definition that declares a host_budget and sits on the owner's allowlist;
// a repository file can lower the budget but cannot supply either. Test fixtures call this to play the owner.
import fs from 'node:fs';
import path from 'node:path';

export const FIXTURE_BUDGET = Object.freeze({ cpu_ms: 20000, wall_ms: 60000, memory_bytes: 512 * 1024 ** 2, processes: 64, disk_write_bytes: 64 * 1024 ** 2, output_bytes: 65536 });

// Writes <home>/.config/dot-bridge/{checks.json,host-check-allowlist.json} for `repo` (OWNER/NAME) and returns the checks it wrote.
export function writeOwnerHostChecks(home, repo, checks, budget = FIXTURE_BUDGET) {
  const dir = path.join(home, '.config/dot-bridge');
  fs.mkdirSync(dir, { recursive: true });
  const definitions = Object.fromEntries(Object.entries(checks).map(([id, spec]) => [id, { host_budget: budget, ...spec }]));
  fs.writeFileSync(path.join(dir, 'checks.json'), JSON.stringify({ [repo]: { checks: definitions } }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'host-check-allowlist.json'), JSON.stringify({ version: 1, checks: Object.keys(definitions).map(check_id => ({ repo, check_id })) }), { mode: 0o600 });
  return definitions;
}
