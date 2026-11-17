// Choose a durable public route for a subsequent bridge start, and drive any setup Gozar offers.
import readline from 'node:readline';
import {
  RouteError, buildQuery, chooseRoute, dalanRequirements, describeCandidate, describeDisclosure, explainRouteError, gozarHomeFor, resolveGozar, resolveRouteWord, targetFor,
} from './gozar-routes.mjs';
import { cancelRouteSetup, muteableTerminal, runRouteSetup, safeRouteOutput } from './route-setup.mjs';
import { inspectRouteSetting, writeRouteSetting } from './route-setting.mjs';

export const SWITCH_NOTE = 'Next: run `dalan try --public`, then in your MCP client remove the trial connector and add the new URL it prints; a new address cannot reuse the trial sign-in.';
export const ROUTE_ID = 'dalan-main';
const DEFAULT_PORT = 8789;

export function parseSetupArgs(argv) {
  const out = { route: undefined, cancel: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--route') { out.route = argv[++i]; if (out.route === undefined) throw new Error('--route needs a name'); } else if (arg.startsWith('--route=')) out.route = arg.slice(8);
    else if (arg === '--cancel') { out.cancel = argv[++i]; if (!out.cancel) throw new Error('--cancel needs the setup operation ID'); }
    else throw new Error(`unknown option ${arg}; usage: dalan setup [--route NAME | --cancel OPERATION_ID]`);
  }
  if (out.cancel && out.route !== undefined) throw new Error('Choose either --cancel or --route.');
  return out;
}

export async function runSetup({
  argv = [], env = process.env, out = process.stdout, input = process.stdin, interactive = Boolean(process.stdin.isTTY), gozar, gozarHome, answers, port = DEFAULT_PORT,
} = {}) {
  const say = safeRouteOutput(out);
  const { route: routeName, cancel } = parseSetupArgs(argv);
  const found = inspectRouteSetting(env);
  if (!cancel && found.state === 'legacy') {
    say('A saved 0.6 route setting exists. It is left untouched. Moving it to Gozar is a separate, journaled step that keeps the same address; setup never rewrites it.');
    return { route: null, changed: false, legacy: true };
  }
  if (!cancel && found.state === 'unreadable') { say(`The saved route setting could not be read (${found.reason}). It was left untouched.`); return { route: null, changed: false }; }
  const terminal = muteableTerminal(input, out);
  const lines = !answers && interactive ? readline.createInterface({ input, terminal: terminal.terminal, output: terminal.output }) : null;
  const queued = answers ? [...answers] : null;
  const ask = question => new Promise(resolve => {
    if (queued) { out.write(question); return resolve(queued.shift() ?? null); }
    if (!lines) return resolve(null);
    let done = false;
    const finish = answer => { if (!done) { done = true; lines.off('close', onClose); resolve(answer); } };
    const onClose = () => finish(null);
    out.write(question); lines.once('line', finish); lines.once('close', onClose);
  });
  try {
    const home = gozarHome ?? gozarHomeFor(env);
    const runtime = gozar ?? await resolveGozar({ env, home });
    if (cancel) return { cancelled: await cancelRouteSetup({ gozar: runtime, home, operationId: cancel, env, say, ask }) };
    const interaction = {
      say, ask,
      ...(terminal.terminal && {
        async askSecret(label) {
          terminal.mute(true);
          try { return Buffer.from(await ask(`${label} (hidden): `) ?? ''); }
          finally { terminal.mute(false); out.write('\n'); }
        },
        handoff(href) { out.write(`${href}\n`); },
      }),
    };
    const wanted = buildQuery({ home, target: targetFor(port), usage: { kind: 'durable', routeId: ROUTE_ID }, address: 'stable', ...(routeName !== undefined ? { route: routeName } : {}) });
    if (!interactive && !answers) { say('Run `dalan setup` in a terminal to choose a public route.'); return { route: found.setting ?? null, changed: false }; }
    const { query, pick } = await resolveRouteWord({ gozar: runtime, query: wanted });
    const setup = candidate => runRouteSetup({ gozar: runtime, candidate, home, env, ...interaction });
    let candidate;
    try { ({ candidate } = await chooseRoute({ gozar: runtime, query, pick, setup })); }
    catch (error) {
      if (error?.code !== 'setup_required' && !error?.nextAction) throw error;
      const e = explainRouteError(error);
      say(e.line);
      if (e.fix) say(`Next: ${e.fix}`);
      return { route: found.setting ?? null, changed: false };
    }
    for (const line of describeCandidate(candidate)) say(line);
    for (const line of describeDisclosure(candidate)) say(line);
    if (!/^y(es)?$/i.test(String(await ask('Save this route choice? [y/N] ') ?? '').trim())) {
      say('Nothing saved.');
      return { route: found.setting ?? null, changed: false };
    }
    const name = routeName ?? candidate.providerId ?? null;
    const pinned = found.setting?.routeName === name && found.setting?.gozarHome === home ? found.setting.origin : null;
    const setting = { version: 2, requirements: dalanRequirements({ address: 'stable' }), gozarHome: home,
      routeName: name, routeId: ROUTE_ID, origin: pinned, bridgeHome: null };
    writeRouteSetting(setting, env);
    say('Saved the route choice. Dalan checks the route when the bridge starts.');
    say(SWITCH_NOTE);
    return { route: setting, changed: found.state !== 'current' || found.setting.origin !== setting.origin || found.setting.routeName !== setting.routeName };
  } finally { lines?.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  try { await runSetup({ argv }); } catch (error) {
    const e = error instanceof RouteError || error?.code ? explainRouteError(error) : { line: error.message, fix: null };
    process.stderr.write(`dalan: ${e.line}\n${e.fix ? `${e.fix}\n` : ''}`); process.exitCode = 1;
  }
}
