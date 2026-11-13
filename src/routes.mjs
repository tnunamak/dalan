// `dalan routes`: every route Gozar offers for Dalan, as Gozar describes it. Dalan adds no provider knowledge: ids, labels, ports, proof,
// needs and consent text are Gozar's catalog data, printed as returned. The id on each row is what `--route <id>` takes.
import { buildQuery, describeCandidate, describeDisclosure, explainRouteError, gozarHomeFor, resolveGozar, targetFor } from './gozar-routes.mjs';

export const ROUTES_USAGE = 'usage: dalan routes [--json]';
export const RERUN_LINE = 'Rerun with --route <id>, using an id from the list above.';

// Dalan's long-running bridge keeps one durable route, so the catalog is asked for that usage. `lifetimes` on each row shows what else a route can serve.
export function routesQuery({ env = process.env, port = 8789 } = {}) {
  return buildQuery({ home: gozarHomeFor(env), target: targetFor(port), usage: { kind: 'durable', routeId: 'dalan-main' }, address: 'any' });
}

export async function loadCatalog({ gozar, env = process.env } = {}) {
  const runtime = gozar ?? await resolveGozar();
  return runtime.catalogRoutes(routesQuery({ env }));
}

// One block per candidate, in Gozar's order: the shared description, whether it is usable, and the consent text.
export function describeRoutes(catalog) {
  if (!catalog.candidates.length) return ['Gozar offers no routes on this computer.'];
  const lines = [];
  catalog.candidates.forEach((candidate, index) => {
    lines.push(...describeCandidate(candidate, index));
    lines.push(`   eligible: ${candidate.eligible ? 'yes' : 'no'}`);
    describeDisclosure(candidate).forEach((line, i) => lines.push(`   ${i === 0 ? 'consent: ' : '          '}${line}`));
    lines.push('');
  });
  return lines;
}

export async function routesMain({ argv = process.argv.slice(3), env = process.env, out = line => process.stdout.write(`${line}\n`), gozar } = {}) {
  const extra = argv.filter(arg => arg !== '--json');
  if (extra.length) throw new Error(`unknown option ${extra[0]}\n${ROUTES_USAGE}`);
  let catalog;
  try { catalog = await loadCatalog({ gozar, env }); } catch (error) {
    const { line } = explainRouteError(error);
    throw new Error(line);
  }
  if (argv.includes('--json')) out(JSON.stringify(catalog.candidates, null, 2));
  else describeRoutes(catalog).forEach(out);
  return catalog;
}

export async function main() {
  try { await routesMain(); } catch (error) { process.stderr.write(`dalan: routes: ${error.message}\n`); process.exitCode = 1; }
}
