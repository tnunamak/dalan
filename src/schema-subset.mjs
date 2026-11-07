// A small JSON-Schema subset for registered-tool arguments. compileSchema() refuses anything it cannot enforce, so no
// keyword is silently ignored; validateValue() checks a value against the compiled schema. Messages name the field and
// the rule, never the offending value.
//
// Supported: type (object, string, number, integer, boolean, array), properties, required, additionalProperties:false
// (enforced and implied at every object level), enum (scalars), minLength, maxLength, pattern, minimum, maximum, items,
// minItems, maxItems, description, title. Everything else ($ref, oneOf, anyOf, allOf, format, const ...) is refused.
export class SchemaError extends Error {
  constructor(message) { super(message); this.name = 'SchemaError'; }
}

export const SUBSET_LIMITS = Object.freeze({
  maxDepth: 6, maxBytes: 65536, schemaBytes: 16384, maxPattern: 256, defaultString: 8000, defaultArray: 100, maxProperties: 32, maxEnum: 64,
});

const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'items', 'minItems', 'maxItems', 'description', 'title']);
const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---- pattern safety -----------------------------------------------------------------------------------------------
// A pattern is admitted only in one closed form: ^, an optional literal prefix, ONE character class with ONE quantifier,
// then $. Examples: ^[a-f0-9]{64}$, ^[A-Za-z0-9_-]+$, ^job-[0-9]{1,8}$, ^\d{4}$. Matching such a pattern is linear in the
// input: the prefix is fixed text and a single repeated class has no second part to trade characters with, so no input
// can make the engine backtrack. Groups, alternation, several repeats, escapes other than \d and \-, back-references
// and lookaround are refused. Arbitrary operator patterns are a later feature.
export const PATTERN_FORM = '^ + optional literal prefix [A-Za-z0-9_-] + one class such as [a-z0-9_-] or \\d + one of + * {n} {n,m} {n,} + $';
const PATTERN_GRAMMAR = /^\^[A-Za-z0-9_-]{0,32}(?:\[(?:[A-Za-z0-9_.]-[A-Za-z0-9_.]|[A-Za-z0-9_.]|\\-)+-?\]|\\d)(?:\+|\*|\{\d{1,4}\}|\{\d{1,4},\d{0,4}\})\$$/;
function unsafePattern(pattern) {
  return PATTERN_GRAMMAR.test(pattern) ? null : `only the form ${PATTERN_FORM} is allowed`;
}

const regexCache = new Map();
const compiledRegex = pattern => {
  let regex = regexCache.get(pattern);
  if (!regex) { regex = new RegExp(pattern, 'u'); if (regexCache.size > 256) regexCache.clear(); regexCache.set(pattern, regex); }
  return regex;
};

// ---- compile ------------------------------------------------------------------------------------------------------
const canonicalLength = value => JSON.stringify(value)?.length ?? 0;

export function compileSchema(schema) {
  if (canonicalLength(schema) > SUBSET_LIMITS.schemaBytes) throw new SchemaError('schema is too large');
  return compile(schema, 0, 'schema');
}

function compile(schema, depth, path) {
  const bad = why => { throw new SchemaError(`${path}: ${why}`); };
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) bad('must be an object');
  if (depth > SUBSET_LIMITS.maxDepth) bad('nested too deeply');
  for (const key of Object.keys(schema)) if (!KEYWORDS.has(key)) bad(`keyword "${key.slice(0, 40)}" is not supported`);
  if (typeof schema.type !== 'string' || !TYPES.has(schema.type)) bad('type must be object, string, number, integer, boolean or array');
  for (const key of ['description', 'title']) if (schema[key] !== undefined && typeof schema[key] !== 'string') bad(`${key} must be a string`);
  const out = { type: schema.type };
  if (schema.description !== undefined) out.description = schema.description;
  if (schema.title !== undefined) out.title = schema.title;
  const only = (...allowed) => {
    for (const key of ['properties', 'required', 'additionalProperties', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'items', 'minItems', 'maxItems', 'enum'])
      if (schema[key] !== undefined && !allowed.includes(key)) bad(`"${key}" does not apply to type ${schema.type}`);
  };
  const intKeyword = key => {
    if (schema[key] === undefined) return;
    if (!Number.isSafeInteger(schema[key]) || schema[key] < 0) bad(`${key} must be a non-negative integer`);
    out[key] = schema[key];
  };
  const numKeyword = key => {
    if (schema[key] === undefined) return;
    if (typeof schema[key] !== 'number' || !Number.isFinite(schema[key])) bad(`${key} must be a number`);
    out[key] = schema[key];
  };
  if (schema.enum !== undefined) {
    if (schema.type === 'object' || schema.type === 'array') bad('enum applies to scalar types only');
    if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > SUBSET_LIMITS.maxEnum || schema.enum.some(v => !['string', 'number', 'boolean'].includes(typeof v))) bad(`enum must hold 1-${SUBSET_LIMITS.maxEnum} scalars`);
    out.enum = [...schema.enum];
  }
  switch (schema.type) {
    case 'object': {
      only('properties', 'required', 'additionalProperties');
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) bad('additionalProperties may only be false');
      const props = schema.properties ?? {};
      if (!props || typeof props !== 'object' || Array.isArray(props)) bad('properties must be an object');
      const names = Object.keys(props);
      if (names.length > SUBSET_LIMITS.maxProperties) bad('too many properties');
      out.properties = {};
      for (const name of names) {
        if (PROTOTYPE_KEYS.has(name)) bad(`property "${name}" is not allowed`);
        out.properties[name] = compile(props[name], depth + 1, `${path}.${name}`);
      }
      if (schema.required !== undefined) {
        if (!Array.isArray(schema.required) || schema.required.some(r => typeof r !== 'string' || !names.includes(r))) bad('required must list declared properties');
        out.required = [...schema.required];
      }
      out.additionalProperties = false;
      break;
    }
    case 'string': {
      only('minLength', 'maxLength', 'pattern', 'enum');
      intKeyword('minLength'); intKeyword('maxLength');
      out.maxLength = Math.min(out.maxLength ?? SUBSET_LIMITS.defaultString, SUBSET_LIMITS.defaultString);
      if (schema.pattern !== undefined) {
        if (typeof schema.pattern !== 'string' || !schema.pattern) bad('pattern must be a non-empty string');
        if (schema.pattern.length > SUBSET_LIMITS.maxPattern) bad(`pattern is longer than ${SUBSET_LIMITS.maxPattern} characters`);
        const unsafe = unsafePattern(schema.pattern);
        if (unsafe) bad(`pattern is not allowed: ${unsafe}`);
        try { compiledRegex(schema.pattern); } catch { bad('pattern is not a valid expression'); }
        out.pattern = schema.pattern;
      }
      break;
    }
    case 'number': case 'integer':
      only('minimum', 'maximum', 'enum');
      numKeyword('minimum'); numKeyword('maximum');
      break;
    case 'boolean':
      only('enum');
      break;
    case 'array':
      only('items', 'minItems', 'maxItems');
      if (schema.items === undefined) bad('array needs items');
      out.items = compile(schema.items, depth + 1, `${path}[]`);
      intKeyword('minItems'); intKeyword('maxItems');
      out.maxItems = Math.min(out.maxItems ?? SUBSET_LIMITS.defaultArray, SUBSET_LIMITS.defaultArray);
      break;
  }
  return out;
}

// ---- validate -----------------------------------------------------------------------------------------------------
function valueDepth(value, limit) {
  let depth = 0, level = [value];
  while (level.length && depth <= limit) {
    const next = [];
    for (const item of level) if (item && typeof item === 'object') next.push(...(Array.isArray(item) ? item : Object.values(item)));
    if (!next.length) return depth;
    level = next; depth++;
  }
  return depth;
}

export function validateValue(schema, value) {
  let text;
  try { text = JSON.stringify(value); } catch { return ['value: cannot be serialized']; }
  if ((text?.length ?? 0) > SUBSET_LIMITS.maxBytes) return [`value: larger than the ${SUBSET_LIMITS.maxBytes}-byte size cap`];
  if (valueDepth(value, SUBSET_LIMITS.maxDepth) > SUBSET_LIMITS.maxDepth) return [`value: nested deeper than ${SUBSET_LIMITS.maxDepth} levels`];
  const errors = [];
  check(schema, value, 'value', errors);
  return errors;
}

function check(schema, value, path, errors) {
  const fail = why => errors.push(`${path}: ${why}`);
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('must be an object');
      for (const key of Object.keys(value)) {
        if (PROTOTYPE_KEYS.has(key)) { fail('forbidden key'); continue; }
        if (!Object.hasOwn(schema.properties, key)) fail('unknown key');
      }
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing "${key}"`);
      for (const [key, sub] of Object.entries(schema.properties)) if (Object.hasOwn(value, key)) check(sub, value[key], `${path}.${key}`, errors);
      return;
    }
    case 'string':
      if (typeof value !== 'string') return fail('must be a string');
      if (value.length > schema.maxLength) return fail(`longer than ${schema.maxLength}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) fail(`shorter than ${schema.minLength}`);
      if (schema.pattern !== undefined && !compiledRegex(schema.pattern).test(value)) fail('does not match the required pattern');
      break;
    case 'integer': case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return fail(`must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`);
      if (schema.minimum !== undefined && value < schema.minimum) fail(`below ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) fail(`above ${schema.maximum}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return fail('must be a boolean');
      break;
    case 'array':
      if (!Array.isArray(value)) return fail('must be an array');
      if (value.length > schema.maxItems) return fail(`more than ${schema.maxItems} items`);
      if (schema.minItems !== undefined && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
      value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
      return;
  }
  if (schema.enum && !schema.enum.includes(value)) fail('not an allowed value');
}
