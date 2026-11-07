// Local context is evidence for a pinned checkout, never a second repository revision or a change to request identity.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateSubmission, submissionLimits, allowListHeading, outputPathsHeading } from './submission-policy.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const endContext = '\n<!-- dot-context end -->\n\n';
function withContext(brief, context) {
  return `<!-- dot-context v1 ${hash(brief)} ${brief.length} -->\n${context}${endContext}${brief}`;
}

// What the bridge may append to a brief at admission: the sensitive-file scope note, then the scope_paths allow-list, then the output_paths list.
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const bridgeSuffix=new RegExp(`(?:\\n\\nBridge scope note: \\d+ sensitive file\\(s\\) are outside scope_paths; do not read them: [^\\n]+\\.)?(?:\\n\\n${escape(allowListHeading)}\\n[^\\n]+(?:\\n[^\\n]+)*)?(?:\\n\\n${escape(outputPathsHeading)}\\n[^\\n]+(?:\\n[^\\n]+)*)?$`);
// The requester's brief without the bridge-added suffixes.
export const withoutBridgeSuffix=brief=>brief.replace(bridgeSuffix,'');
export function stripPacked(brief) {
  const header = /^<!-- dot-context v1 ([a-f0-9]{64}) (\d+) -->\n/.exec(brief);
  if (!header) return withoutBridgeSuffix(brief);
  const end = brief.indexOf(endContext, header[0].length);
  if (end < 0) return brief;
  const start = end + endContext.length, original = brief.slice(start, start + Number(header[2]));
  const tail = brief.slice(start + original.length);
  // The bridge can append its scope note and allow-list after admission. Verify the stored requester slice, and accept
  // only those known suffixes; arbitrary trailing text must still fail the attach guard.
  if (tail && withoutBridgeSuffix(tail) !== '') return brief;
  return hash(original) === header[1] ? original : brief;
}

// Async git with a per-call timeout and an overall packing deadline, so a slow or hung git never blocks the
// event loop (ACP notifications, the cancel window) and never runs unbounded across many files.
const GIT_CALL_MS = 15000, PACK_DEADLINE_MS = 120000;
function git(cwd, args, { maxBuffer = 4 * 1024 * 1024, diff = false, deadline } = {}) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('context packer deadline exceeded'));
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'buffer', timeout: Math.min(GIT_CALL_MS, remaining), killSignal: 'SIGKILL', maxBuffer }, (error, stdout) => {
      if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error?.code === 'ENOBUFS') return reject(Object.assign(new Error('local diff exceeds brief limit'), { oversize: true }));
      if (error && !(diff && error.code === 1)) return reject(new Error('context packer cannot read git state'));
      resolve(stdout);
    });
  });
}
const names = buffer => new TextDecoder('utf-8', { fatal: true }).decode(buffer).split('\0').filter(Boolean);
const sensitiveError = error => /^(?:hard sensitive (?:path|content|patch content) exclusion|sensitive scope path):?/.test(error.message);
const sizeError = error => /^(?:brief|task instructions): \d+ UTF-8 bytes exceeds/.test(error.message);

export async function packRepoDiff(cwd, assignment, base, noRepoNote) {
  const deadline = Date.now() + PACK_DEADLINE_MS;
  const run = (dir, args, options) => git(dir, args, { ...options, deadline });
  // Validate requester text independently: an unsafe brief must not become acceptable by dropping local context.
  const textOnly = { ...assignment, inputs: [] };
  delete textOnly.scope_paths;
  validateSubmission(textOnly);
  cwd = (await run(cwd, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];
  const tracked = names(await run(cwd, [...diffArgs, '--name-only', '-z', base, '--']));
  const untracked = names(await run(cwd, ['ls-files', '--others', '--exclude-standard', '-z']));
  const changed = [...new Set([...tracked, ...untracked])].sort();
  const untrackedSet = new Set(untracked), trackedSet = new Set(tracked), omitted = new Set();
  const probe = (file, diff = '') => validateSubmission({ ...assignment, brief: 'Review the local change.', scope_paths: [file] }, {
    scanInput: () => ({ files: [file], diffFiles: [file], diff, symlinks: [] }),
  });
  // Check paths before asking git for their contents; never collect an env/key/signing file's hunk.
  for (const file of changed) {
    try { probe(file); }
    catch (error) { if (!sensitiveError(error)) throw error;omitted.add(file); }
  }
  const diagnostics = () => changed.map(file => omitted.has(file) ? `omitted: ${file} (sensitive)` : `changed: ${file}`);
  const fallback = reason => {
    let context = `Context not packed: ${reason}.\nChanged files:`;
    // File lists can themselves be larger than a brief. Keep complete names, then report the number left out.
    let listed = 0;
    for (const line of diagnostics()) {
      const next = `${context}\n${line}`;
      const candidate = { ...textOnly, brief: `${noRepoNote}\n\n${withContext(assignment.brief, next + `\n${changed.length} more changed file names exceed the brief limit.`)}` };
      try { validateSubmission(candidate); }
      catch (error) { if (sizeError(error)) break;throw error; }
      context = next;listed++;
    }
    if (listed < changed.length) context += `\n${changed.length - listed} more changed file names exceed the brief limit.`;
    const out = { ...textOnly, brief: `${noRepoNote}\n\n${withContext(assignment.brief, context)}` };
    validateSubmission(out);
    return out;
  };
  const chunks = [], skipped = [];
  try {
    for (const file of changed) {
      if (omitted.has(file)) continue;
      let raw = await run(cwd, untrackedSet.has(file)
        ? [...diffArgs, '--no-index', '--', '/dev/null', file]
        : [...diffArgs, base, '--', `:(literal)${file}`], { maxBuffer: submissionLimits.brief, diff: untrackedSet.has(file) });
      // A staged deletion can leave a recreated untracked file at the same path. Preserve the deletion before its
      // addition so the patch applies to a base where that path already exists.
      if (untrackedSet.has(file) && trackedSet.has(file)) raw = Buffer.concat([
        await run(cwd, [...diffArgs, base, '--', `:(literal)${file}`], { maxBuffer: submissionLimits.brief }), raw,
      ]);
      let diff;
      try { diff = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
      catch { skipped.push(`omitted: ${file} (binary)`);continue; }
      if (raw.includes(0) || /^Binary files /m.test(diff)) { skipped.push(`omitted: ${file} (binary)`);continue; }
      if (/^(?:new (?:file )?mode|old mode|deleted file mode) 120000$/m.test(diff)) { skipped.push(`omitted: ${file} (symlink)`);continue; }
      try { probe(file, diff); }
      catch (error) {
        if (sensitiveError(error)) { omitted.add(file);continue; }
        if (error.code === 'DOT_BRIDGE_INFRASTRUCTURE') throw error;
        return fallback('submission policy rejected local context');
      }
      chunks.push(diff);
      if (Buffer.byteLength(chunks.join('')) > submissionLimits.brief) return fallback('diff exceeds assignment limits');
    }
  } catch (error) {
    if (error.oversize) return fallback('diff exceeds assignment limits');
    throw error;
  }
  const diff = chunks.join('');
  // Choose a fence longer than any run in repository text, so source Markdown cannot close the diff fence.
  const fence = '`'.repeat(Math.max(3, ...[...diff.matchAll(/`+/g)].map(m => m[0].length + 1)));
  const context = [
    `The repository checkout is at pushed base ${base}. Apply this unified diff mentally to see the requester's state.`,
    'For checks, use apply_patch if implementation scope permits it; otherwise return a proposed patch/check plan. Binary and sensitive files are omitted.',
    ...[...omitted].map(file => `omitted: ${file} (sensitive)`), ...skipped,
    `${fence}diff\n${diff}${fence}`,
  ].join('\n');
  const out = { ...assignment, brief: withContext(assignment.brief, context) };
  const tree = names(await run(cwd, ['ls-tree', '-r', '-z', base]));
  const files = tree.map(entry => entry.slice(entry.indexOf('\t') + 1));
  const symlinks = tree.filter(entry => entry.startsWith('120000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1));
  try {
    // Match the bridge's pinned-base scan, including its scope narrowing and the bytes of its appended note.
    validateSubmission(out, { excludeSensitive: true, scanInput: () => ({ files, diffFiles: [], diff: '', symlinks }) });
  } catch (error) {
    if (error.code === 'DOT_BRIDGE_INFRASTRUCTURE') throw error;
    return fallback(sizeError(error) ? 'diff exceeds assignment limits' : 'submission policy rejected local context');
  }
  // The bridge owns scope_excluded and will repeat admission itself; never send the locally narrowed result.
  return out;
}
