#!/usr/bin/env node
// Exit 0 when a bridge listens on the admin socket the daemon would use for this HOME; otherwise exit 1.
// Used by bin/catalog-release.sh. It only connects; it sends nothing. It always probes when run: there is no
// "is this the main module" test to skip it, since a skipped probe would read as ready.
import net from 'node:net';
import { bridgeSocket } from './admin-socket-probe-lib.mjs';

const probe = net.connect(bridgeSocket());
probe.setTimeout(1000, () => process.exit(1));
probe.once('connect', () => process.exit(0));
probe.once('error', () => process.exit(1));
