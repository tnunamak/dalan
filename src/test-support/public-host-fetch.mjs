import http from 'node:http';
// Node's fetch does not permit overriding Host. HTTP auth fixtures use a real
// request with the public Host while connecting to their loopback test listener.
export function fetchForPublicHost(host) {
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return fetch(input, options);
    return new Promise((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(options.headers));
      const request = http.request(url, { method: options.method ?? 'GET', headers: { ...headers, host }, signal: options.signal }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve(new Response([204,205,304].includes(response.statusCode) ? null : Buffer.concat(chunks), {
          status: response.statusCode, headers: response.headers,
        })));
      });
      request.on('error', reject);
      request.end(options.body);
    });
  };
}
