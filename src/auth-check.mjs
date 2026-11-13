// `dalan doctor --auth`: a real OAuth client walk against the PUBLIC MCP URL of this home's bridge. The walk itself is
// runSelfCheck; here the owner's approval is done through the owner admin socket, and the one connection it creates is
// revoked when the walk ends. A worker that already has a connection is never touched: approving would replace it.
// No token, pairing code, secret path or full URL is written to any output.
import fs from 'node:fs';
import path from 'node:path';
import { runSelfCheck } from './try-selfcheck.mjs';

const fail = (name, detail) => ({ ok: false, results: [{ name, status: 'FAIL', detail }] });

export async function runAuthCheck({ home, workers, worker, request, operator, fetchImpl = fetch, say = () => {}, approveWaitMs = 30_000 }) {
  let url;
  try { url = fs.readFileSync(path.join(home, 'resource-url'), 'utf8').trim(); } catch { url = ''; }
  if (!url) {
    const detail = `no resource-url file in ${home}: this home has no public MCP URL to check (run dalan setup or dalan try first)`;
    say(`FAIL input: ${detail}`); say('RESULT FAIL');
    return fail('input', detail);
  }
  const names = [...workers];
  if (worker && !names.includes(worker)) { const detail = `unknown worker; configured workers: ${names.join(', ') || 'none'}`; say(`FAIL input: ${detail}`); say('RESULT FAIL'); return fail('input', detail); }
  if (!worker) {
    if (names.length !== 1) { const detail = names.length ? `${names.length} workers are configured (${names.join(', ')}); choose one with --worker NAME` : 'no worker is configured'; say(`FAIL input: ${detail}`); say('RESULT FAIL'); return fail('input', detail); }
    worker = names[0];
  }
  const headers = () => ({ 'x-operator-key': operator() });
  let listing;
  try { listing = await request('/connect/list', 'GET', null, headers()); }
  catch (error) { const detail = `cannot ask the bridge about connections: ${String(error?.message ?? error).split('\n')[0].slice(0, 160)}`; say(`FAIL bridge: ${detail}`); say('RESULT FAIL'); return fail('bridge', detail); }
  const existing = (listing.connections ?? []).some(c => c.worker === worker && c.revoked_at === null);
  if (existing) {
    const partial = await runSelfCheck({ url, fetchImpl, say, discoveryOnly: true });
    const detail = `worker ${worker} already has a connection (it would be replaced)`;
    say(`SKIP full walk: ${detail}`);
    return { ok: false, partial: true, results: [...partial.results, { name: 'full walk', status: 'SKIP', detail }] };
  }
  // Registration needs an open pairing window, so the window opens first. A window that is already open is never taken
  // over, not even one for this worker: its owner may be pairing a client right now. Doctor only reports it.
  if (listing.window) {
    const detail = listing.window.worker === worker
      ? `your own pairing window is already open (worker ${worker}); doctor cannot check sign-in while it is open. Finish pairing the client, then run doctor again; or run dalan connect stop, then run doctor again`
      : `a pairing window is already open (worker ${listing.window.worker}); finish it or run dalan connect stop, then retry`;
    say(`FAIL input: ${detail}`); say('RESULT FAIL'); return fail('input', detail);
  }
  let approved = false;
  const approve = async ({ code }) => {
    try { await request('/connect/approve', 'POST', { code, worker, replace: false }, headers()); approved = true; }
    catch (error) { throw new Error(`the owner approval was refused: ${String(error?.message ?? error).split('\n')[0].replaceAll(code, '[code]').slice(0, 120)}`); }
  };
  let outcome, cleanupFailed = false;
  try { await request('/connect/start', 'POST', { worker }, headers()); }
  catch (error) { const detail = `cannot open the pairing window: ${String(error?.message ?? error).split('\n')[0].slice(0, 120)}`; say(`FAIL bridge: ${detail}`); say('RESULT FAIL'); return fail('bridge', detail); }
  try { outcome = await runSelfCheck({ url, fetchImpl, say, approve, approveWaitMs }); }
  finally {
    // Leave the worker as it was: this walk's one connection goes, and a window it opened closes.
    if (approved) { try { await request('/connect/revoke', 'POST', { worker }, headers()); say(`cleanup: the self-check connection for worker ${worker} was revoked`); } catch { cleanupFailed = true; say('FAIL cleanup: the self-check connection could not be revoked; run: dalan connect revoke ' + worker); } }
    try { await request('/connect/stop', 'POST', {}, headers()); } catch { /* the window expires by itself */ }
  }
  return cleanupFailed ? { ok: false, results: [...outcome.results, { name: 'cleanup', status: 'FAIL', detail: `the self-check connection for worker ${worker} was not revoked` }] } : outcome;
}
