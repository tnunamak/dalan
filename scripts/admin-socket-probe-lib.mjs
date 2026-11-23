// The admin socket the daemon would bind for a HOME. The data root comes from the daemon's own resolution (src/paths.mjs),
// so a legacy-named unit on either data layout is probed at its real socket.
import os from 'node:os';
import { adminSocketPath } from '../src/admin-socket.mjs';
import { defaultPath } from '../src/paths.mjs';

export const bridgeSocket = (home = os.homedir()) => adminSocketPath(defaultPath(home, '.local/share/dot-bridge'));
