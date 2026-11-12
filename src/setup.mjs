// `dalan setup`: choose the saved public route. Gozar owns every route; Dalan asks it what is possible, shows what it returned, asks once,
// and saves only the requirements, the opaque route name and the pinned origin (route-setting.mjs, version 2).
import readline from 'node:readline';
import {
  RouteError, buildQuery, dalanRequirements, describeCandidate, describeDisclosure, ensureDurableRoute, explainRouteError, gozarHomeFor, resolveGozar, targetFor,
} from './gozar-routes.mjs';
import { inspectRouteSetting, writeRouteSetting } from './route-setting.mjs';

export const SWITCH_NOTE = 'Next: run `dalan try --public`, then in your MCP client remove the trial connector and add the new URL it prints; a new address cannot reuse the trial sign-in.';
export const ROUTE_ID = 'dalan-main';
const DEFAULT_PORT = 8789;

export function parseSetupArgs(argv) {
  const out = { route: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--route') { out.route = argv[++i]; if (out.route === undefined) throw new Error('--route needs a name'); } else if (arg.startsWith('--route=')) out.route = arg.slice(8);
    else throw new Error(`unknown option ${arg}; usage: dalan setup [--route NAME]`);
  }
  return out;
}

export async function runSetup({
  argv = [], env = process.env, out = process.stdout, input = process.stdin, interactive = Boolean(process.stdin.isTTY), gozar, gozarHome, answers, port = DEFAULT_PORT,
} = {}) {
  const say = line => out.write(`${line}\n`);
  const { route: routeName } = parseSetupArgs(argv);
  const found = inspectRouteSetting(env);
  if (found.state === 'legacy') {
    say('A saved 0.6 route setting exists. It is left untouched. Moving it to Gozar is a separate, journaled step that keeps the same address; setup never rewrites it.');
    return { route: null, changed: false, legacy: true };
  }
  if (found.state === 'unreadable') { say(`The saved route setting could not be read (${found.reason}). It was left untouched.`); return { route: null, changed: false }; }
  const lines = !answers && interactive ? readline.createInterface({ input }) : null;
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
    const runtime = gozar ?? await resolveGozar();
    const home = gozarHome ?? gozarHomeFor(env);
    const query = buildQuery({ home, target: targetFor(port), usage: { kind: 'durable', routeId: ROUTE_ID }, address: 'stable', ...(routeName !== undefined ? { route: routeName } : {}) });
    if (!interactive && !answers) { say('Run `dalan setup` in a terminal to choose a public route.'); return { route: found.setting ?? null, changed: false }; }
    const consent = async candidate => {
      for (const line of describeCandidate(candidate)) say(line);
      for (const line of describeDisclosure(candidate)) say(line);
      const answer = String((await ask('Use this route for public runs? [y/N] ')) ?? '').trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    };
    let view;
    try { view = await ensureDurableRoute({ gozar: runtime, query, consent }); } catch (error) {
      if (error?.tryKind === 'consent') { say('Nothing saved.'); return { route: found.setting ?? null, changed: false }; }
      if (error?.code === 'setup_required' || error?.nextAction) { const e = explainRouteError(error); say(e.line); if (e.fix) say(`Next: ${e.fix}`); return { route: found.setting ?? null, changed: false }; }
      throw error;
    }
    const setting = { version: 2, requirements: dalanRequirements({ address: 'stable' }), gozarHome: home, routeName: routeName ?? null, routeId: ROUTE_ID, origin: view.origin, bridgeHome: null };
    writeRouteSetting(setting, env);
    say(`Saved. Public runs use ${view.origin}. A changed address needs a new sign-in.`);
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
