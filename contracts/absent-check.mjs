// Rules for the two expectations the public map cases add to the Reader API's case format: `absent` (what a
// response must never carry) and `spans` (the distance between two timestamps of every item). Called from
// validate-reader-cases.mjs; unit-tested in absent-check.test.mjs.
//
// The replay of a case is each implementation's own. What is checked here is that a case cannot be vacuous:
// an `absent` key must be something the declared response schema cannot carry at all, every `absent` value is
// a marker the world really contains, and the expectation also needs something positive (an empty body
// would pass any absence).

const unref = (components, s) => {
  let cur = s;
  while (cur?.$ref) cur = components.schemas[cur.$ref.split('/').pop()];
  return cur;
};

/** Every property name (lowercase) the schema can carry at any depth. */
export function schemaKeys(schema, components, seen = new Set()) {
  const out = new Set();
  const walk = (s) => {
    if (!s || typeof s !== 'object') return;
    if (s.$ref) {
      if (seen.has(s.$ref)) return;
      seen.add(s.$ref);
      walk(components.schemas[s.$ref.split('/').pop()]);
      return;
    }
    for (const [k, v] of Object.entries(s.properties ?? {})) { out.add(k.toLowerCase()); walk(v); }
    if (s.patternProperties || (s.additionalProperties && s.additionalProperties !== false)) out.add('*');
    for (const part of ['allOf', 'oneOf', 'anyOf']) for (const v of s[part] ?? []) walk(v);
    walk(s.items);
  };
  walk(schema);
  return out;
}

/** The schemas a JSON pointer (array indexes and `-` stand for `items`) can reach from `schema`. */
export function schemasAt(schema, pointer, components) {
  let level = [schema];
  for (const seg of pointer.split('/').slice(1)) {
    const next = [];
    const visit = (s) => {
      s = unref(components, s);
      if (!s) return;
      for (const part of ['allOf', 'oneOf', 'anyOf']) for (const v of s[part] ?? []) visit(v);
      if (s.properties?.[seg]) next.push(s.properties[seg]);
      if (/^[0-9]+$/.test(seg) && s.items) next.push(s.items);
    };
    level.forEach(visit);
    level = next;
  }
  return level.map((s) => unref(components, s)).filter(Boolean);
}

/** Errors for an `absent` expectation. `ctx`: { schema, components, worldText, positive }. */
export function checkAbsent(absent, ctx) {
  const errors = [];
  const keys = absent.keys ?? [];
  const values = absent.values ?? [];
  if (!keys.length && !values.length) errors.push('absent names no key and no value');
  if (!ctx.positive) errors.push('absent needs a positive match or body check beside it: an empty body passes any absence');
  const carried = schemaKeys(ctx.schema, ctx.components);
  for (const k of keys) {
    if (carried.has(k.toLowerCase())) errors.push(`absent key ${k} is a property the response schema allows`);
  }
  if (keys.length && carried.has('*')) errors.push('the response schema allows arbitrary keys, so no key can be absent');
  const world = ctx.worldText.toLowerCase();
  for (const v of values) {
    if (!world.includes(v.toLowerCase())) errors.push(`absent value ${JSON.stringify(v)} does not occur in the world, so the check proves nothing`);
  }
  return errors;
}

/** Errors for a `spans` expectation: both pointers must name a date-time of the item the array holds. */
export function checkSpans(spans, ctx) {
  const errors = [];
  for (const s of spans) {
    const items = schemasAt(ctx.schema, s.at, ctx.components).filter((a) => a.type === 'array');
    if (!items.length) { errors.push(`spans: ${s.at} is not an array of the response`); continue; }
    for (const p of [s.from, s.to]) {
      const found = items.flatMap((a) => schemasAt(a.items, p, ctx.components));
      if (!found.some((f) => f.type === 'string' && f.format === 'date-time')) {
        errors.push(`spans: ${p} is not a date-time of the items at ${s.at}`);
      }
    }
    if (!(s.seconds > 0)) errors.push('spans: seconds must be positive');
  }
  return errors;
}
