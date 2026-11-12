import { defaultPath } from './paths.mjs';
import os from 'node:os';
import path from 'node:path';
import { assertPrivateDir, untrusted, writeAtomic } from './as-files.mjs';
import { normalizeCode, PAIRING_MINUTES } from './as-files.mjs';
const WAKE_POLL_SECONDS = 60;

// `dalan connect ...`: the owner's side of the built-in authorization server. Every call goes through the owner Unix
// socket with the operator key; none of it exists on the public listener.
const USAGE = 'usage: dalan connect add-client --redirect-uri URI [--name NAME] [--json] | clients [--json] | remove-client CLIENT_ID | start --worker NAME [--minutes N] | stop | reset | pending | approve CODE --worker NAME [--confirm-redirect URI] [--replace] | list | revoke NAME | allow-callback PATTERN | signal-token [--worker NAME] [--rotate] [--json]';

// Terminal-safe text: vendor-supplied strings never reach the terminal as raw bytes.
const q = value => JSON.stringify(String(value ?? '').replace(/[\p{C}\p{Z}]+/gu, ' ').trim());

export function formatPending(result) {
  if (!result.window) return 'No pairing window is open. Run: dalan connect start --worker NAME';
  const lines = [`Pairing window open for worker ${result.window.worker} until ${result.window.expires_at}`];
  if (!result.pending.length) lines.push('No pending connections.');
  for (const p of result.pending) {
    lines.push('', `code        ${p.code}`, `worker      ${p.worker}`, `client_id   ${q(p.client_id)}`, `client_name [untrusted, set by the app] ${q(p.client_name)}`,
      `redirect    ${q(p.redirect_uri)}`, ...(p.redirect_host ? [`host        ${q(p.redirect_host)} (the redirect host; the app name above proves nothing)`] : []), ...(p.redirect_punycode ? ['WARNING     the host contains punycode (xn--); it may look like another name when decoded'] : []), `resource    ${q(p.resource)}`, `scopes      ${p.scopes.map(q).join(' ')}`, `age         ${p.age_seconds}s (expires in ${p.expires_in_seconds}s)`,
      ...(p.superseded ? [`SUPERSEDED  by the newer attempt ${p.superseded_by}; an app that registered again cannot finish this one, so approve the newest code`] : []),
      ...(p.native ? ['WARNING     native client, identity not verified: host and name prove nothing; teammate must read this code from the browser page on their own machine and compare it over a trusted channel', '            redirect confirmation is a typo check only; it is not identity proof', `APPROVE     dalan connect approve ${p.code} --worker ${p.worker}   (approves this code only; other pending codes are unaffected. A native client also needs the exact redirect shown above.)`] : []));
  }
  if (result.pending.length) lines.push('', 'Compare the code the teammate reads from their browser page over a trusted channel. Approve only that matching transaction. The code of a native client is approved by that code only; confirm the exact redirect shown above as a typo check.');
  return lines.join('\n');
}

export function formatClients(result) {
  if (!result.clients.length) return 'No OAuth clients are registered.';
  return result.clients.map(client => [
    `client_id   ${q(client.client_id)}`, `type        ${client.type}`, `client_name [untrusted] ${q(client.client_name)}`,
    `redirect_uris ${client.redirect_uris.map(q).join(' ')}`, `created_at  ${client.created_at}`,
  ].join('\n')).join('\n\n');
}

export async function connectCommand(args, { request, operator, option, json }) {
  const sub = args.shift();
  const headers = () => ({ 'x-operator-key': operator() });
  const flags = new Set(['--json', '--replace', '--rotate']);
  const valued = new Set(['--worker', '--minutes', '--redirect-uri', '--name', '--confirm-redirect']);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (valued.has(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${args[i]} requires a value`);
      i++; continue;
    }
    if (flags.has(args[i])) continue;
    if (args[i].startsWith('--')) throw new Error(`unknown option ${args[i]}; ${USAGE}`);
    positional.push(args[i]);
  }
  if (sub !== 'add-client' && (args.includes('--redirect-uri') || args.includes('--name'))) throw new Error(`${sub} does not accept --redirect-uri or --name; ${USAGE}`);
  if (sub !== 'approve' && args.includes('--confirm-redirect')) throw new Error(`${sub} does not accept --confirm-redirect; ${USAGE}`);
  const worker = option('--worker');
  if (args.includes('--worker') && (!worker || worker.startsWith('--'))) throw new Error('--worker requires a name');
  switch (sub) {
    case 'add-client': {
      const redirectUri = option('--redirect-uri'), name = option('--name');
      if (!redirectUri || positional.length || args.includes('--worker') || args.includes('--minutes') || args.includes('--replace')
        || args.filter(arg => arg === '--redirect-uri').length !== 1 || args.filter(arg => arg === '--name').length > 1) throw new Error(USAGE);
      const result = await request('/connect/add-client', 'POST', { redirect_uri: redirectUri, ...(name !== null ? { name } : {}) }, headers());
      return json ? { result } : { result: `Created public client.\nclient_id ${q(result.client_id)}`, plain: true };
    }
    case 'clients': {
      if (positional.length || args.some(arg => arg !== '--json')) throw new Error(USAGE);
      const result = await request('/connect/clients', 'GET', null, headers());
      return json ? { result } : { result: formatClients(result), plain: true };
    }
    case 'remove-client': {
      if (positional.length !== 1 || args.some(arg => arg.startsWith('--') && arg !== '--json')) throw new Error(USAGE);
      const result = await request('/connect/remove-client', 'POST', { client_id: positional[0] }, headers());
      return json ? { result } : { result: `Removed static client ${q(result.client_id)}.`, plain: true };
    }
    case 'start': {
      if (!worker || positional.length) throw new Error(USAGE);
      const minutes = option('--minutes');
      if (args.includes('--minutes') && (!/^\d+$/.test(minutes ?? ''))) throw new Error('--minutes requires an integer');
      return { result: await request('/connect/start', 'POST', { worker, ...(minutes ? { minutes: Number(minutes) } : {}) }, headers()) };
    }
    case 'reset': if (positional.length) throw new Error(USAGE); return { result: await request('/connect/reset', 'POST', {}, headers()) };
    case 'stop': if (positional.length) throw new Error(USAGE); return { result: await request('/connect/stop', 'POST', {}, headers()) };
    case 'pending': {
      if (positional.length) throw new Error(USAGE);
      const result = await request('/connect/pending', 'GET', null, headers());
      return json ? { result } : { result: formatPending(result), plain: true };
    }
    case 'approve': {
      if (positional.length !== 1 || !worker) throw new Error(USAGE);
      const view = await request('/connect/pending', 'GET', null, headers());
      const matches = view.pending.filter(item => normalizeCode(item.code) === normalizeCode(positional[0]));
      if (matches.length !== 1) {
        const reason = matches.length ? 'More than one pending pairing matches this code. Run dalan connect pending and compare codes before approval.'
          : `No pending pairing matches this code. The attempt may have expired (attempts last ${PAIRING_MINUTES} minutes) or the code may be mistyped. Start the sign-in again in the client, then compare codes with dalan connect pending before approval.`;
        throw new Error(`${reason}\n\n${formatPending({ ...view, pending: matches.length ? matches : view.pending })}`);
      }
      const pairing = matches[0];
      const confirmRedirect = option('--confirm-redirect');
      if (pairing.native) {
        const review = formatPending({ ...view, pending: [pairing] });
        if (confirmRedirect === null) throw new Error(`Native callback needs explicit redirect typo confirmation. Compare the full URI with the browser page and compare the code the teammate reads from that page over a trusted channel; this flag does not prove identity. Rerun with --confirm-redirect ${q(pairing.redirect_uri)}.\n\n${review}`);
        if (confirmRedirect !== pairing.redirect_uri) throw new Error(`confirmed redirect does not match the pending callback ${q(pairing.redirect_uri)}; this flag is only a typo check, not identity proof.\n\n${review}`);
      } else if (confirmRedirect !== null) throw new Error('--confirm-redirect is only valid for a native callback');
      const approval = await request('/connect/approve', 'POST', { code: positional[0], worker, replace: args.includes('--replace'), ...(confirmRedirect !== null ? { confirm_redirect: confirmRedirect } : {}) }, headers());
      const review = formatPending({ ...view, pending: [pairing] });
      return json ? { result: approval, review } : { result: `${review}\n\nApproved ${q(pairing.code)} for worker ${q(pairing.worker)}.${approval.replaced ? ` Replaced connection ${q(approval.replaced)}: this client now gets every queued and future job for worker ${q(pairing.worker)}, including briefs approved before the switch.` : ''}`, plain: true };
    }
    case 'list': if (positional.length) throw new Error(USAGE); return { result: await request('/connect/list', 'GET', null, headers()) };
    case 'revoke': if (positional.length !== 1 || worker) throw new Error(USAGE); return { result: await request('/connect/revoke', 'POST', { worker: positional[0] }, headers()) };
    case 'signal-token': {
      if (positional.length || args.some((arg, i) => arg !== '--json' && arg !== '--rotate' && arg !== '--worker' && args[i - 1] !== '--worker')) throw new Error(USAGE);
      const result = await request('/connect/signal-token', 'POST', { rotate: args.includes('--rotate'), ...(worker ? { worker } : {}) }, headers());
      // The poll interval is advice for the hook owner; it is set in the hook, not on the bridge.
      const seconds = WAKE_POLL_SECONDS;
      const dir = defaultPath(os.homedir(),'.config/dot-bridge');
      assertPrivateDir(dir);
      const file = path.join(dir, `signal-url.${result.worker}`);
      writeAtomic(file, `${result.url}\n`);
      // stdout contains only the private file path; the hook owner can read it without exposing the URL in logs.
      if (json) return { result: { path: file, worker: result.worker, rotated: result.rotated, poll_interval_seconds: seconds } };
      process.stderr.write(`Hook poll interval: ${seconds} s or more. Do not poll faster than every 60 s.\n`);
      return { result: file, plain: true };
    }
    case 'allow-callback': if (positional.length !== 1) throw new Error(USAGE); return { result: await request('/connect/allow-callback', 'POST', { pattern: positional[0] }, headers()) };
    default: throw new Error(USAGE);
  }
}
