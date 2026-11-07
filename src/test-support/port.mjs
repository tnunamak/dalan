// A port for a child server that the test starts later, possibly more than once.
// listen(0) returns a port from the kernel's ephemeral range. After it is closed, the kernel can give that
// port to any outgoing connection or listen(0) on the host, so a later bind by the child fails with
// EADDRINUSE and requests to it fail with "fetch failed". Ports below the ephemeral range are never
// assigned automatically; pick one at random and confirm that it is free now.
import fs from 'node:fs';
import net from 'node:net';

export const ephemeralRange = () => {
  try {
    const [low, high] = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    if (Number.isInteger(low) && Number.isInteger(high)) return [low, high];
  } catch {}
  return [49152, 65535]; // IANA dynamic range, used by macOS
};

const bindable = port => new Promise(resolve => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

export async function reservedPort({ low = 20000, attempts = 200 } = {}) {
  const high = Math.min(ephemeralRange()[0], 32768) - 1;
  for (let i = 0; i < attempts; i++) {
    const port = low + Math.floor(Math.random() * (high - low + 1));
    if (await bindable(port)) return port;
  }
  throw new Error(`no free port in ${low}-${high}`);
}
