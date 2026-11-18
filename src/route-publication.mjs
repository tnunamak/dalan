import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './as-files.mjs';
import { isPublished, resolveGozar } from './gozar-routes.mjs';

// A service may outlive the installer. Recheck the retained handle and withdraw
// the private handoff whenever the SDK no longer publishes the configured origin.
export function watchServicePublication({ home, configDir, origin, secret, canWrite }) {
  const urlFile = path.join(home, 'resource-url');
  const serviceFile = path.join(configDir, 'service-install.json');
  const workerFile = path.join(configDir, 'route-reference.json');
  let runtime, runtimeKey, expires, delay = 1000;
  const target = fs.existsSync(serviceFile) ? serviceFile : workerFile;
  const read = () => {
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    return target === serviceFile ? { home: value.gozar_home, handle: value.route_handle, custody: value.route_custody } : value;
  };
  const withdraw = () => {
    clearTimeout(expires);
    fs.rmSync(urlFile, { force: true });
  };
  const refresh = async () => {
    try {
      if (!canWrite()) return;
      const ref = read();
      if (!ref.home || !ref.handle) { if (ref.home) withdraw(); return; }
      const key = JSON.stringify([ref.home, ref.custody]);
      if (key !== runtimeKey) {
        runtime = await resolveGozar({ home: ref.home, custody: ref.custody });
        runtimeKey = key;
      }
      const view = await runtime.routeStatus({ home: ref.home, handle: ref.handle });
      if (!canWrite() || JSON.stringify(read()) !== JSON.stringify(ref)) return;
      if (!isPublished(view) || view.published !== origin) { withdraw(); return; }
      const url = `${view.published}/${secret}/mcp\n`;
      let current;
      try { current = fs.readFileSync(urlFile, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (url !== current) writeAtomic(urlFile, url);
      const validity = view.verification.validUntil;
      const remaining = validity?.known ? Date.parse(validity.value) - Date.now() : 1000;
      clearTimeout(expires);
      expires = setTimeout(() => { if (canWrite()) withdraw(); }, Math.max(0, remaining));
      expires.unref();
      delay = Math.max(250, Math.min(5000, remaining / 2));
    } catch {
      if (canWrite() && fs.existsSync(target)) withdraw();
    } finally { setTimeout(refresh, delay).unref(); }
  };
  void refresh();
}
