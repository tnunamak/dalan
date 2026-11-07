import { defaultPath } from './paths.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const policyFile = () => defaultPath(os.homedir(),'.config/dot-bridge/host-check-allowlist.json');
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const checkPattern = /^[A-Za-z0-9_.-]{1,64}(?:\/[A-Za-z0-9_.-]{1,64})*$/;

// The file is a separate owner-controlled activation capability. Invalid or
// unavailable state denies every check; callers must not cache this result.
export function readHostCheckAllowlist(file = policyFile(), ownerUid = process.getuid()) {
  try {
    const entry = fs.lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== ownerUid || (entry.mode & 0o777) !== 0o600) return null;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o777) !== 0o600 || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > 65536) return null;
      const bytes = Buffer.alloc(stat.size + 1);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (count > 65536) return null;
      const value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'checks,version' || value.version !== 1 || !Array.isArray(value.checks)) return null;
      const pairs = new Set();
      for (const pair of value.checks) {
        if (!pair || Array.isArray(pair) || typeof pair !== 'object' || Object.keys(pair).sort().join(',') !== 'check_id,repo' ||
          typeof pair.repo !== 'string' || !repoPattern.test(pair.repo) || pair.repo.split('/').some(part => part === '.' || part === '..' || part.includes('..')) ||
          typeof pair.check_id !== 'string' || !checkPattern.test(pair.check_id) || pair.check_id.split('/').some(part => part === '.' || part === '..' || part.includes('..'))) return null;
        const key = `${pair.repo}\0${pair.check_id}`;
        if (pairs.has(key)) return null;
        pairs.add(key);
      }
      return pairs;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

export function hostCheckPairAllowed(repo, checkId) {
  const pairs = readHostCheckAllowlist();
  return !!pairs && pairs.has(`${repo}\0${checkId}`);
}
