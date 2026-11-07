// Owner-side drift lint for check definitions: what each check's argv names, and ids that sound like a test file the argv leaves out.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { ownerChecks, normalizeCheck, argvTestFiles, testFileName, mirrorPath } from './projects.mjs';
import { gitEnv } from './git-env.mjs';

const stemTokens = file => {
  const base = file.split('/').pop().replace(/\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|go|sh)$|\.py$/, '').replace(/^test_/, '');
  return base.split(/[-_.]+/).filter(Boolean).filter((t, i) => !(i === 0 && /^v\d+$/.test(t)));
};
const contiguous = (hay, needle) => needle.length > 0 && hay.some((_, i) => needle.every((t, j) => hay[i + j] === t));
// A test file the id names: its stem tokens sit inside the id's tokens, or (two or more id tokens) the id sits inside the stem.
export function filesNamedById(id, treeFiles) {
  const idTokens = id.split(/[-_.]+/).filter(Boolean);
  return treeFiles.filter(f => {
    if (!testFileName.test(f)) return false;
    const stem = stemTokens(f);
    if (!stem.length) return false;
    if (stem.length === 1) return stem[0] === id;
    return contiguous(idTokens, stem) || (idTokens.length >= 2 && contiguous(stem, idTokens));
  });
}

// Does the argv run this file? A word names it by path suffix or by glob (`tests/*.test.mjs`); `cd dir && ... ../x/a.test.ts` style
// relative paths match on the same basename, so a file the command reaches from another directory is not reported as missing.
export function argvCovers(argv, file) {
  const base = file.split('/').pop();
  for (const el of argv) for (const raw of String(el).split(/[\s'"=;&|()<>]+/)) {
    const w = raw.replace(/^(?:\.\.?\/)+/, '');
    if (!w || w.startsWith('-')) continue;
    if (!w.includes('*')) { if (w === file || file.endsWith(`/${w}`) || w.split('/').pop() === base) return true; continue; }
    const re = new RegExp(`(?:^|/)${w.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    if (re.test(file)) return true;
  }
  return false;
}

// Tracked files in the mirror: HEAD plus the most recently committed ref (a mirror's HEAD can lag the branch work happens on). null with no mirror.
export function mirrorTree(repo) {
  let mirror;
  try { mirror = mirrorPath(repo); } catch { return null; }
  if (!fs.existsSync(mirror)) return null;
  const git = args => spawnSync('git', ['-C', mirror, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: gitEnv() });
  const newest = git(['for-each-ref', '--count=1', '--sort=-committerdate', '--format=%(refname)']).stdout.trim();
  const files = new Set();
  let ok = false;
  for (const ref of ['HEAD', newest].filter(Boolean)) {
    const out = git(['ls-tree', '-r', '--name-only', ref]);
    if (out.status === 0) { ok = true; for (const f of out.stdout.split('\n')) if (f) files.add(f); }
  }
  return ok ? [...files] : null;
}

export function lintChecksFile({ tree = mirrorTree } = {}) {
  const repos = [];
  for (const [repo, source] of Object.entries(ownerChecks())) {
    const treeFiles = tree(repo);
    const checks = [];
    for (const [id, def] of Object.entries(source?.checks || {})) {
      const entry = { id, test_files: [], warnings: [], errors: [] };
      try {
        const spec = normalizeCheck(def, id);
        entry.test_files = spec.test_paths ?? argvTestFiles(spec.argv);
        // A check whose argv names no test file runs a whole suite (go test, npm test, make): there is nothing to compare.
        if (treeFiles && entry.test_files.length && id !== 'default')
          for (const f of filesNamedById(id, treeFiles)) if (!argvCovers(spec.argv, f)) entry.warnings.push(`id suggests ${f}, which argv does not run`);
      } catch (error) { entry.errors.push(error.message); }
      checks.push(entry);
    }
    repos.push({ repo, tree_checked: treeFiles !== null, checks });
  }
  return repos;
}

export function formatChecksReport(repos) {
  const lines = [];
  let warnings = 0, errors = 0;
  for (const r of repos) {
    lines.push(`${r.repo}${r.tree_checked ? '' : ' (no local mirror: id/file name lint skipped)'}`);
    for (const c of r.checks) {
      lines.push(`  ${c.id}: ${c.test_files.length ? c.test_files.join(' ') : '(argv names no test files)'}`);
      for (const w of c.warnings) { lines.push(`    WARNING: ${w}`); warnings++; }
      for (const e of c.errors) { lines.push(`    ERROR: ${e}`); errors++; }
    }
  }
  lines.push(`${warnings} warning(s), ${errors} error(s)`);
  return lines.join('\n');
}
