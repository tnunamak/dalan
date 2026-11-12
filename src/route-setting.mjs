// The owner's saved choice of public route, written by `dalan setup`. One small file in the user's config directory, outside every
// trial home, so a trial that is deleted never loses it and a trial never writes it. Values: 'tailscale' (a real, stable address) or
// 'localhost.run' (keep using trial links). No file means no choice yet, which runs the trial route.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROUTE_CHOICES = ['tailscale', 'localhost.run'];
export const routeSettingPath = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'dalan', 'route.json');

export function readRouteSetting(env = process.env) {
  try {
    const route = JSON.parse(fs.readFileSync(routeSettingPath(env), 'utf8'))?.route;
    return ROUTE_CHOICES.includes(route) ? route : null;
  } catch { return null; }
}

export function writeRouteSetting(route, env = process.env) {
  if (!ROUTE_CHOICES.includes(route)) throw new Error(`unknown route ${JSON.stringify(route)}`);
  const file = routeSettingPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify({ route })}\n`, { mode: 0o600 });
  return file;
}
