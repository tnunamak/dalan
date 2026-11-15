// A port for a child server that the test starts later, possibly more than once.
// listen(0) returns a port from the kernel's ephemeral range. After it is closed, the kernel can give that
// port to any outgoing connection or listen(0) on the host, so a later bind by the child fails with
// EADDRINUSE and requests to it fail with "fetch failed". Ports below the ephemeral range are never
// assigned automatically; pick one at random and confirm that it is free now.
import fs from 'node:fs';
import net from 'node:net';

// Read the actual port after a child server starts with PORT=0. Keep this at the test edge:
// callers that need a stable URL before startup must use a different setup.
export function portFromListeningBanner(output) {
  const match = /(?:^|\n)MCP listening on [^\r\n]+:(\d+)\r?\n/.exec(String(output));
  const port = match ? Number(match[1]) : null;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

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

// Without start, return a port that is free now. With start, retry only if the actual bind
// fails with EADDRINUSE; return both the selected port and the callback's result.
export async function reservedPort({ low = 20000, attempts = 200, start } = {}) {
  const high = Math.min(ephemeralRange()[0], 32768) - 1;
  for (let i = 0; i < attempts; i++) {
    const port = low + Math.floor(Math.random() * (high - low + 1));
    if (!await bindable(port)) continue;
    if (!start) return port;
    try { return { port, value: await start(port) }; }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error(`no free port in ${low}-${high}`);
}
