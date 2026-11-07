import http from 'node:http';

// Limits on receiving requests do not limit tool execution or the lifetime of an SSE response.
export function createBuiltinHttpServer(handler) {
  const server = http.createServer({ headersTimeout: 10000, requestTimeout: 30000, keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 }, (req, res) => {
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      const headers = typeof args[1] === 'string' ? args[2] : args[1];
      let contentType = this.getHeader('content-type');
      const entries = Array.isArray(headers) ? Array.from({ length: headers.length / 2 }, (_, i) => [headers[i * 2], headers[i * 2 + 1]]) : Object.entries(headers ?? {});
      for (const [name, value] of entries) if (name.toLowerCase() === 'content-type') contentType = value;
      const result = writeHead.apply(this, args);
      if (/^text\/event-stream(?:;|$)/i.test(String(contentType ?? ''))) this.setTimeout(0);
      return result;
    };
    return handler(req, res);
  });
  server.maxConnections = 128;
  // T3 waits may take 120 seconds. Leave a minute for dispatch and delivery.
  server.setTimeout(180000, socket => socket.destroy());
  return server;
}
