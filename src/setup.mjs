// `dalan setup`: move from a trial link to a real, stable address. It detects what it can and asks as little as possible:
// Tailscale found and ready for Funnel -> one yes/no question; not found -> one short choice. The answer is saved, so
// `dalan try --public` asks nothing afterwards.
import readline from 'node:readline';
import { INSTALL_URL, defaultTailscale, preflight, whichOnPath } from '../scripts/lib/expose-tailscale.mjs';
import { readRouteSetting, writeRouteSetting } from './route-setting.mjs';

// What this computer's Tailscale can do now: { ok, node } or { ok: false, installed, reason }.
// The address is the OAuth issuer, so a new address is a new sign-in identity: nothing from a trial carries over.
export const SWITCH_NOTE = 'Next: run `dalan try --public`, then in your MCP client remove the trial connector and add the new URL it prints; a new address cannot reuse the trial sign-in.';

export function detectTailscale({ env = process.env, tailscale = defaultTailscale, which = name => whichOnPath(name, env), platform = process.platform, mac } = {}) {
  if (!which('tailscale')) return { ok: false, installed: false, reason: 'Tailscale is not installed.' };
  try {
    const found = preflight({ tailscale, platform, mac });
    return { ok: true, node: found.dnsName.split('.')[0], dnsName: found.dnsName };
  } catch (error) { return { ok: false, installed: true, reason: String(error.message).split('\n')[0] }; }
}

export async function runSetup({ env = process.env, out = process.stdout, input = process.stdin, interactive = Boolean(process.stdin.isTTY), detect = () => detectTailscale({ env }) } = {}) {
  const say = line => out.write(`${line}\n`);
  const found = detect();
  const saved = readRouteSetting(env);
  const lines = interactive ? readline.createInterface({ input }) : null;
  const ask = question => new Promise(resolve => {
    let done = false;
    const finish = answer => { if (!done) { done = true; lines.off('close', onClose); resolve(answer); } };
    const onClose = () => finish(null);
    out.write(question); lines.once('line', finish); lines.once('close', onClose);
  });
  try {
    if (found.ok) {
      if (!interactive) { say(`Tailscale is ready on this computer (${found.node}). Run \`dalan setup\` in a terminal to use it.`); return { route: saved, changed: false }; }
      const answer = ((await ask(`Use Tailscale (${found.node}) for a stable address? [Y/n] `)) ?? '').trim().toLowerCase();
      if (answer === '' || answer === 'y' || answer === 'yes') {
        writeRouteSetting('tailscale', env);
        say('Saved. `dalan try --public` now uses your Tailscale address, which stays the same between runs. This is a real address, not a trial link.');
        say(SWITCH_NOTE);
        return { route: 'tailscale', changed: saved !== 'tailscale' };
      }
      writeRouteSetting('localhost.run', env);
      say('Saved. `dalan try --public` keeps making trial links (localhost.run). Run `dalan setup` again to switch.');
      return { route: 'localhost.run', changed: saved !== 'localhost.run' };
    }
    say(found.reason);
    say('For daily use, pick one:');
    say(`  1. Tailscale (recommended): install it from ${INSTALL_URL}, run \`tailscale up\`, then run \`dalan setup\` again.`);
    say('  2. Keep using trial links (localhost.run): no setup, but the address changes within hours.');
    if (!interactive) return { route: saved, changed: false };
    const answer = ((await ask('Choose [1]: ')) ?? '').trim();
    if (answer === '2') {
      writeRouteSetting('localhost.run', env);
      say('Saved. `dalan try --public` keeps making trial links.');
      return { route: 'localhost.run', changed: saved !== 'localhost.run' };
    }
    say('Nothing saved. Install Tailscale, then run `dalan setup` again.');
    return { route: saved, changed: false };
  } finally { lines?.close(); }
}

export async function main() {
  try { await runSetup(); } catch (error) { process.stderr.write(`dalan: ${error.message}\n`); process.exitCode = 1; }
}
