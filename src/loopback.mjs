// Check authority before routing, discovery, OAuth or MCP. Forwarded headers cannot
// substitute a trusted authority on a listener intended for direct local clients.
export function loopbackRequestAllowed(req, origin) {
  const count = name => req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length;
  if (count('host') !== 1 || req.headers.host !== new URL(origin).host) return false;
  if (Object.keys(req.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'))) return false;
  if (count('origin') > 1) return false;
  return req.headers.origin === undefined || req.headers.origin === origin;
}
