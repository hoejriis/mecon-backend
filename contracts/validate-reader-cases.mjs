// Validates the Reader API conformance cases (contracts/reader-api/v1/cases) against the OpenAPI document they
// test: each file matches cases.schema.json and names the document's version; every world and action exists
// with its arguments; every request names a real operation with exactly its path parameters, only its query
// parameters (its required ones included) and its required headers; a request body matches the operation's request schema unless the case
// marks it `invalid`, in which case it must fail (an operation without a request body takes one only so marked);
// a `count: 0` match is paired with a positive one at the same place; every expected status is declared for the operation, with
// the schema and headers that status declares; captures are defined before use; and every operation has at
// least one case. Called from validate.mjs. An implementation replays the same files (see cases/README.md).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { checkAbsent, checkSpans } from './absent-check.mjs';

const VAR = /\$\{([a-z][a-z0-9_]*)\}/g;
const PLACEHOLDER = 'synthetic_capture';

export function validateReaderCases(dir = 'reader-api/v1', name = 'mecon-reader-api') {
  let checked = 0;
  let failures = 0;
  const fail = (m) => { failures++; console.error('FAIL', m); };
  const ok = (m) => { checked++; console.log('ok  ', m); };
  const doc = parse(readFileSync(join(dir, 'openapi.yaml'), 'utf8'));
  const casesDir = join(dir, 'cases');
  const readJson = (f) => JSON.parse(readFileSync(join(casesDir, f), 'utf8'));
  const contract = `${name}/${doc.info.version}`;

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: 'openapi', components: doc.components });
  const fixRef = (s) => JSON.parse(JSON.stringify(s).replaceAll('"#/components/', '"openapi#/components/'));
  const fileSchema = ajv.compile(readJson('cases.schema.json'));

  // operationId -> { method, path, op, params }
  const ops = {};
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      const params = (op.parameters ?? []).map((p) => (p.$ref ? doc.components.parameters[p.$ref.split('/').pop()] : p));
      ops[op.operationId] = { method: method.toUpperCase(), path, op, params };
    }
  }
  const response = (op, status) => {
    let r = op.responses?.[String(status)];
    if (r?.$ref) r = doc.components.responses[r.$ref.split('/').pop()];
    return r;
  };
  const schemaName = (r) => {
    const media = Object.values(r?.content ?? {})[0];
    if (!media) return null;
    return media.schema?.$ref?.split('/').pop() ?? '(inline)';
  };
  const declaredHeaders = (r) => Object.keys(r?.headers ?? {}).map((h) => h.toLowerCase());
  const substitute = (v) => JSON.parse(JSON.stringify(v ?? null).replace(VAR, PLACEHOLDER));
  const varsIn = (v) => [...JSON.stringify(v ?? null).matchAll(VAR)].map((m) => m[1]);

  const worldsFile = readJson('worlds.json');
  if (worldsFile.contract !== contract) fail(`cases/worlds.json names ${worldsFile.contract}, the document is ${contract}`);
  const actions = worldsFile.actions;
  const covered = new Set();
  const ids = new Set();
  const files = readdirSync(casesDir).filter((f) => f.endsWith('.json') && f !== 'worlds.json' && f !== 'cases.schema.json').sort();
  if (!files.length) fail('no case files in cases/');

  for (const f of files) {
    const data = readJson(f);
    if (!fileSchema(data)) { fail(`cases/${f}: ${ajv.errorsText(fileSchema.errors)}`); continue; }
    if (data.contract !== contract) fail(`cases/${f} names ${data.contract}, the document is ${contract}`);
    if (`${data.group}.json` !== f) fail(`cases/${f} has group ${data.group}`);
    for (const c of data.cases) {
      const where = `cases/${f} ${c.id}`;
      const before = failures;
      if (ids.has(c.id)) fail(`${where}: duplicate case id`);
      ids.add(c.id);
      if (!c.id.startsWith(`${data.group}-`)) fail(`${where}: id does not start with its group`);
      if (!worldsFile.worlds[c.world]) fail(`${where}: unknown world ${c.world}`);
      const defined = new Set();
      const use = (v, what) => { for (const n of varsIn(v)) if (!defined.has(n)) fail(`${where}: ${what} uses \${${n}} before it is captured`); };
      c.steps.forEach((s, i) => {
        const at = `${where} step ${i + 1}`;
        if (s.action) {
          const a = actions[s.action];
          if (!a) { fail(`${at}: unknown action ${s.action}`); return; }
          const given = Object.keys(s.args ?? {}).sort().join(',');
          if (given !== [...a.args].sort().join(',')) fail(`${at}: ${s.action} takes [${a.args}], got [${given}]`);
          use(s.args, s.action);
          if (s.capture) defined.add(s.capture);
          return;
        }
        const o = ops[s.request.operation];
        if (!o) { fail(`${at}: unknown operation ${s.request.operation}`); return; }
        covered.add(s.request.operation);
        const { op, params } = o;
        use(s.request, 'request');
        use(s.expect, 'expect');
        // Path parameters: exactly the template's. Query: only declared ones, required ones given unless the request is
        // marked invalid. Headers: required ones given, none unknown.
        const want = [...o.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort().join(',');
        const got = Object.keys(s.request.path ?? {}).sort().join(',');
        if (want !== got) fail(`${at}: ${o.path} needs path [${want}], got [${got}]`);
        const q = params.filter((p) => p.in === 'query').map((p) => p.name);
        for (const k of Object.keys(s.request.query ?? {})) if (!q.includes(k)) fail(`${at}: query ${k} is not a parameter of ${s.request.operation}`);
        for (const p of params) if (p.in === 'query' && p.required && !s.request.invalid && !(p.name in (s.request.query ?? {}))) fail(`${at}: required query ${p.name} missing`);
        const hp = params.filter((p) => p.in === 'header' && p.name !== 'X-CSRF-Token');
        const given = Object.keys(s.request.headers ?? {});
        for (const p of hp) if (p.required && !given.includes(p.name)) fail(`${at}: required header ${p.name} missing`);
        for (const h of given) if (!hp.some((p) => p.name === h)) fail(`${at}: header ${h} is not a parameter of ${s.request.operation}`);
        const hasCsrf = params.some((p) => p.name === 'X-CSRF-Token');
        if (s.request.csrf && !hasCsrf) fail(`${at}: csrf given but ${s.request.operation} takes no CSRF token`);
        // Body.
        const media = op.requestBody?.content?.['application/json'];
        if (!media) {
          if (s.request.body !== undefined && !s.request.invalid) fail(`${at}: ${s.request.operation} takes no body; a case sending one marks it invalid`);
        } else if (s.request.body === undefined) {
          if (op.requestBody.required) fail(`${at}: ${s.request.operation} needs a body`);
        } else {
          const v = ajv.compile(fixRef(media.schema));
          const valid = v(substitute(s.request.body));
          if (s.request.invalid && valid) fail(`${at}: body is marked invalid but matches the request schema`);
          if (!s.request.invalid && !valid) fail(`${at}: body fails the request schema: ${ajv.errorsText(v.errors)}`);
        }
        if (s.request.invalid && s.expect.status !== 422) fail(`${at}: an invalid body must expect 422`);
        // Expectation against what the document declares for that status.
        const r = response(op, s.expect.status);
        if (!r) { fail(`${at}: ${s.expect.status} is not declared for ${s.request.operation}`); return; }
        const name = schemaName(r);
        if (name !== s.expect.schema) fail(`${at}: ${s.expect.status} declares schema ${name}, case expects ${s.expect.schema}`);
        if (s.expect.schema && !doc.components.schemas[s.expect.schema]) fail(`${at}: no component schema ${s.expect.schema}`);
        const dh = declaredHeaders(r);
        for (const [h, want] of Object.entries(s.expect.headers ?? {})) if (!dh.includes(h.toLowerCase()) && want !== 'absent') fail(`${at}: header ${h} is not declared for ${s.expect.status}`);
        const isStream = Object.keys(r.content ?? {}).includes('text/event-stream');
        if (s.expect.stream && !isStream) fail(`${at}: stream expected but ${s.expect.status} is not an event stream`);
        if (isStream && !s.expect.stream) fail(`${at}: ${s.expect.status} is an event stream; give a bounded stream expectation`);
        if (s.expect.lease && s.expect.schema !== 'LeaseKeyList') fail(`${at}: a lease check runs against a LeaseKeyList response`);
        if (s.expect.ids && isStream) fail(`${at}: an ids check reads a JSON body, not an event stream`);
        // `absent` and `spans` (the public map cases): what the response must never carry, and the distance between
        // two timestamps of every item. See absent-check.mjs.
        if (s.expect.absent || s.expect.spans) {
          const rootSchema = doc.components.schemas[s.expect.schema];
          const ctx = { schema: rootSchema, components: doc.components, worldText: JSON.stringify(worldsFile) };
          const positive = (s.expect.match ?? []).some((m) => m.at_least >= 1 || m.count >= 1) || Object.keys(s.expect.body ?? {}).length > 0;
          if (isStream) fail(`${at}: absent and spans read a JSON body, not an event stream`);
          else if (!rootSchema) fail(`${at}: absent and spans need a response schema`);
          else {
            if (s.expect.absent) for (const e of checkAbsent(s.expect.absent, { ...ctx, positive })) fail(`${at}: ${e}`);
            if (s.expect.spans) for (const e of checkSpans(s.expect.spans, ctx)) fail(`${at}: ${e}`);
          }
        }
        // A `count: 0` alone passes on an empty array, so it proves nothing: pair it with a match at the same place
        // that needs at least one item.
        for (const [where, ms] of [['body', s.expect.match ?? []], ['stream', s.expect.stream?.match ?? []]]) {
          for (const m of ms) {
            if (m.count !== 0) continue;
            if (!ms.some((o) => o.at === m.at && (o.at_least >= 1 || o.count >= 1))) fail(`${at}: ${where} match count 0 at ${JSON.stringify(m.at)} has no positive match beside it`);
          }
        }
        // Body values that are not captures must themselves fit the schema at that pointer: checked by the replay.
        for (const n of Object.keys(s.capture ?? {})) defined.add(n);
      });
      if (failures === before) ok(`${dir}/${where}`);
    }
  }
  for (const id of Object.keys(ops)) if (!covered.has(id)) fail(`operation ${id} has no conformance case`);
  if (Object.keys(ops).every((id) => covered.has(id))) ok(`every one of ${Object.keys(ops).length} ${name} operations has a case`);
  return { checked, failures };
}
