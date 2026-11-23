#!/usr/bin/env node
// Exit 0 when a bridge listens on the admin socket the daemon itself would use for this HOME; otherwise exit 1.
// Used by bin/catalog-release.sh. It only connects; it sends nothing. The data root comes from the daemon's own
// resolution (src/paths.mjs), so a legacy-named unit on either data layout is probed at its real socket.
import net from 'node:net';
import os from 'node:os';
import { adminSocketPath } from '../src/admin-socket.mjs';
import { defaultPath } from '../src/paths.mjs';

export const bridgeSocket = (home = os.homedir()) => adminSocketPath(defaultPath(home, '.local/share/dot-bridge'));

if (import.meta.url === `file://${process.argv[1]}`) {
  const probe = net.connect(bridgeSocket());
  probe.setTimeout(1000, () => process.exit(1));
  probe.once('connect', () => process.exit(0));
  probe.once('error', () => process.exit(1));
}
