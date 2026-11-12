import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultPath } from './paths.mjs';
import { acquireUpdateLock } from './service-update-lock.mjs';
import { writeAtomic } from './as-files.mjs';

const safePath = /^[A-Za-z0-9_@+=:,./-]+$/;

export function autoUpdateUnits({ home, unit, node }) {
  const name = unit.replace(/\.service$/, '');
  if (!/^dalan-[a-z0-9-]+$/.test(name)) throw new Error('invalid Dalan service unit');
  if (![home, node].every(value => path.isAbsolute(value) && safePath.test(value))) throw new Error('update units require absolute systemd-safe paths');
  const timer = `${name}-update.timer`;
  return { timer, files: {
    [`${name}-update.service`]: [
      '[Unit]', 'Description=Check and update the Dalan bridge', 'After=network-online.target', '',
      '[Service]', 'Type=oneshot',
      `ExecStart=${node} ${home}/current/bin/dalan.mjs service update --home ${home} --json`,
      `Environment=PATH=${[path.dirname(node), '/usr/local/bin', '/usr/bin', '/bin'].join(':')}`,
      'UMask=0077', 'TimeoutStartSec=20min', 'Nice=19', 'IOSchedulingClass=idle', '',
    ].join('\n'),
    [timer]: [
      '[Unit]', 'Description=Daily Dalan update check', '', '[Timer]', 'OnCalendar=daily',
      'RandomizedDelaySec=1h', 'Persistent=true', '', '[Install]', 'WantedBy=timers.target', '',
    ].join('\n'),
  } };
}

export async function setAutoUpdate({ home, enabled }, seams = {}) {
  if ((seams.platform ?? process.platform) !== 'linux') throw new Error('automatic service updates currently require Linux with a systemd user manager');
  if (typeof enabled !== 'boolean') throw new Error('auto-update requires on or off');
  home = path.resolve(home);
  if (fs.realpathSync(home) !== home) throw new Error('service home must not use a symlink');
  const config = defaultPath(home, '.config/dot-bridge');
  const receiptFile = path.join(config, 'service-install.json');
  const info = fs.lstatSync(receiptFile);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error('service receipt must be a private regular file');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (receipt.home !== home || !receipt.unit_dir || !receipt.node) throw new Error('reinstall this service with the current Dalan release before enabling automatic updates');
  if (!safePath.test(receipt.unit_dir) || !path.isAbsolute(receipt.unit_dir) || fs.realpathSync(receipt.unit_dir) !== receipt.unit_dir) throw new Error('service unit directory must be a real absolute directory');
  const releaseLock = acquireUpdateLock(home);
  const spawn = seams.spawn ?? spawnSync;
  const run = args => {
    const result = spawn('systemctl', ['--user', ...args], { encoding: 'utf8', env: seams.env ?? process.env, timeout: 30000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`systemctl ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  };
  try {
    const { files, timer } = autoUpdateUnits(receipt);
    // Refuse collisions before replacing either generated unit.
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(receipt.unit_dir, name);
      if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== text)) throw new Error(`${file} has different contents; refusing to replace it`);
    }
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(receipt.unit_dir, name), text, { mode: 0o644 });
    run(['daemon-reload']);
    run([enabled ? 'enable' : 'disable', '--now', timer]);
    writeAtomic(receiptFile, `${JSON.stringify({ ...receipt, auto_update: enabled }, null, 2)}\n`);
    return { home, auto_update: enabled, timer };
  } finally { releaseLock(); }
}
