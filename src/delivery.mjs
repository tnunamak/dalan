const t3ThreadIdPattern = /^[A-Za-z0-9._:%-]+$/;
export const maxT3ThreadIdLength = 1024;

// T3 uses UUIDs, `mcp:<uuid>`, and opaque delegated/provider IDs.  Keep this
// deliberately bounded while accepting the characters present in those forms.
export function validT3ThreadId(value) {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= maxT3ThreadIdLength
    && t3ThreadIdPattern.test(value);
}

export function parseDelivery(value) {
  if (value === 'none') return { mode: 'none', threadId: null };
  if (typeof value === 'string' && value.startsWith('t3:') && validT3ThreadId(value.slice(3))) {
    return { mode: 't3', threadId: value.slice(3) };
  }
  throw new Error('invalid delivery; expected none or t3:<thread-id>');
}
