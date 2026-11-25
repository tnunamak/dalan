export function canonicalValue(value, errorCode = 'invalid_json') {
  const active = new WeakSet();
  const invalid = () => Object.assign(new Error(errorCode), { code: errorCode });

  function visit(item) {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    const array = Array.isArray(item);
    if (!array && (!item || Object.getPrototypeOf(item) !== Object.prototype)) throw invalid();
    if (active.has(item)) throw invalid();
    active.add(item);
    try {
      if (array) {
        const values = [];
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) throw invalid();
          values.push(visit(item[i]));
        }
        return values;
      }
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, visit(item[key])]));
    } finally {
      // Sibling branches may legitimately share the same object.
      active.delete(item);
    }
  }

  return visit(value);
}

export const canonicalJson = (value, errorCode) => JSON.stringify(canonicalValue(value, errorCode));
