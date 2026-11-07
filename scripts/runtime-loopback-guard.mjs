// Preload in the bridge and its CLI: fail closed before any non-loopback TCP dial.
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect passes an already-normalized argument array to Socket.connect.
  const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  if (!options.path && !['127.0.0.1', '::1', 'localhost'].includes(options.host ?? 'localhost')) {
    throw new Error('runtime integration test forbids non-loopback network');
  }
  return connect.apply(this, args);
};
syncBuiltinESMExports();
