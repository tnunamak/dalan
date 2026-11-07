export function canonicalValue(value, errorCode = 'invalid_json') {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonicalValue(item, errorCode));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key], errorCode)]));
  }
  throw Object.assign(new Error(errorCode), { code: errorCode });
}

export const canonicalJson = (value, errorCode) => JSON.stringify(canonicalValue(value, errorCode));
