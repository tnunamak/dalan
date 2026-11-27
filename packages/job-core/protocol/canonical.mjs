export function canonicalValue(value, errorCode = 'invalid_json') {
  const active = new WeakSet();
  const invalid = () => Object.assign(new Error(errorCode), { code: errorCode });

  const data = (item, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(item, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
    return descriptor.value;
  };

  function visit(item) {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    const array = Array.isArray(item);
    if (!array) {
      if (!item || typeof item !== 'object') throw invalid();
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw invalid();
    }
    if (active.has(item)) throw invalid();
    active.add(item);
    try {
      if (array) {
        const values = [];
        for (let i = 0; i < item.length; i++) {
          values.push(visit(data(item, i)));
        }
        return values;
      }
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(data(item, key))]));
    } finally {
      // Sibling branches may legitimately share the same object.
      active.delete(item);
    }
  }

  return visit(value);
}

export const canonicalJson = (value, errorCode) => JSON.stringify(canonicalValue(value, errorCode));
