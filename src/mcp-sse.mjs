const HEARTBEAT = ': keepalive\n\n';

export function acceptsMcpEventStream(accept) {
  return typeof accept === 'string' && accept.split(',').some(entry => {
    const [mediaType, ...parameters] = entry.trim().toLowerCase().split(';').map(part => part.trim());
    if (mediaType !== 'text/event-stream') return false;
    const quality = parameters.find(parameter => parameter.startsWith('q='));
    return !quality || Number(quality.slice(2)) > 0;
  });
}

export function beginMcpEventStream(res, { heartbeatMs = 20_000, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let active = true, timer = null, writtenBytes = 0;
  const stop = () => {
    if (!active) return;
    active = false;
    if (timer !== null) clearIntervalFn(timer);
  };
  res.once('close', stop);
  res.once('finish', stop);
  res.once('error', stop);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
  const heartbeat = () => {
    if (!active || res.destroyed) { stop(); return; }
    res.write(HEARTBEAT);
    writtenBytes += Buffer.byteLength(HEARTBEAT);
  };
  heartbeat();
  if(active) {
    timer = setIntervalFn(heartbeat, heartbeatMs);
    timer?.unref?.();
  }
  return {
    finish(jsonText, beforeEnd = () => {}) {
      if (!active || res.destroyed) { stop(); return 0; }
      const frame = `event: message\ndata: ${jsonText}\n\n`;
      const bytes = writtenBytes + Buffer.byteLength(frame);
      stop();
      beforeEnd(bytes);
      res.write(frame);
      res.end();
      return bytes;
    },
    close: stop,
  };
}

export function mcpResponseText(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (!lines.some(line => line.startsWith(':') || /^(?:data|event|id|retry):/.test(line))) return normalized;
  const frames = [];
  let data = [];
  const endFrame = () => { if (data.length) frames.push(data.join('\n')); data = []; };
  for (const line of lines) {
    if (line === '') { endFrame(); continue; }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  endFrame();
  return frames.at(-1);
}
