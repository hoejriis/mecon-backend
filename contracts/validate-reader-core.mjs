// Checks of the reader-core contract (contracts/reader-core/v1) that the shared fixture and case validators do not
// make: every schema it copies from the Reader API is identical to the Reader API's own, so the core answers exactly
// what the facade relays; every caller-scoped operation takes the caller reference and declares session_ended; and
// every operation declares the transport answers (401, 503, and 422 when it takes a body). Called from validate.mjs.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

// The Reader API's resource shapes the core answers with, and every schema they reference.
export const SHARED = ['OpaqueId', 'Timestamp', 'Health', 'LoginStarted', 'ListMeta', 'Device', 'DeviceList', 'Identity',
  'IdentityList', 'Target', 'Conversation', 'ConversationList', 'Message', 'MessageList', 'Contact', 'ContactList',
  'Channel', 'ChannelList', 'SendRequest', 'SendStatus', 'SendAttempt', 'EventEnvelope', 'LeaseOperation',
  'LeasePayload', 'LeaseToken', 'LeaseIssued', 'LeaseKey', 'LeaseKeyList'];
// Pre-session operations: no caller reference.
const NO_CALLER = new Set(['getHealth', 'startLogin', 'pollLogin']);

export function validateReaderCore(dir = 'reader-core/v1', apiDir = 'reader-api/v1') {
  let checked = 0;
  let failures = 0;
  const fail = (m) => { failures++; console.error('FAIL', m); };
  const ok = (m) => { checked++; console.log('ok  ', m); };
  const core = parse(readFileSync(`${dir}/openapi.yaml`, 'utf8'));
  const api = parse(readFileSync(`${apiDir}/openapi.yaml`, 'utf8'));
  const schemas = core.components.schemas;

  for (const name of SHARED) {
    if (!schemas[name]) fail(`${dir}: shared schema ${name} is missing`);
    else if (!isDeepStrictEqual(schemas[name], api.components.schemas[name])) fail(`${dir}: ${name} differs from ${apiDir}'s`);
  }
  if (failures === 0) ok(`${dir}: the ${SHARED.length} schemas shared with ${apiDir} are identical`);
  // A $ref inside a shared schema must land on a shared schema too, or the copy could drift through it.
  const refs = (v) => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, c]) => (k === '$ref' ? [c] : refs(c))) : []);
  for (const name of SHARED) {
    for (const r of refs(schemas[name] ?? {})) {
      const target = r.split('/').pop();
      if (!SHARED.includes(target)) fail(`${dir}: shared ${name} references ${target}, which is not shared`);
    }
  }

  const resolveResponse = (r) => (r?.$ref ? core.components.responses[r.$ref.split('/').pop()] : r);
  const bodySchema = (op) => {
    const ref = op.requestBody?.content?.['application/json']?.schema?.$ref;
    return ref ? schemas[ref.split('/').pop()] : undefined;
  };
  const responseSchema = (op, status) => resolveResponse(op.responses?.[status])?.content?.['application/json']?.schema?.$ref?.split('/').pop();
  // A Refusal, or a schema that narrows one (allOf the Refusal plus a narrower `code`), so the replay asserts the code.
  const isRefusal = (name) => name === 'Refusal'
    || (schemas[name]?.allOf ?? []).some((s) => s.$ref === '#/components/schemas/Refusal');
  // Every narrowed code must be one Refusal allows.
  for (const [name, s] of Object.entries(schemas)) {
    if (name === 'Refusal' || !isRefusal(name)) continue;
    const all = new Set(schemas.Refusal.properties.code.enum);
    for (const part of s.allOf) {
      const c = part.properties?.code;
      for (const v of c ? (c.enum ?? [c.const]) : []) if (!all.has(v)) fail(`${dir}: ${name} narrows code to ${v}, which Refusal does not allow`);
    }
  }
  const before = failures;
  let n = 0;
  for (const [path, item] of Object.entries(core.paths)) {
    for (const [method, op] of Object.entries(item)) {
      n++;
      const id = op.operationId;
      if (responseSchema(op, '401') !== 'ServiceError') fail(`${id}: 401 must answer ServiceError`);
      if (responseSchema(op, '503') !== 'Refusal') fail(`${id}: 503 must answer Refusal`);
      const body = bodySchema(op);
      if (method === 'get') {
        if (body || !NO_CALLER.has(id)) fail(`${id}: only a pre-session operation without a body may be a GET (${path})`);
        continue;
      }
      if (!body) { fail(`${id}: a POST takes a JSON body`); continue; }
      if (body.additionalProperties !== false) fail(`${id}: its request schema must refuse unknown members`);
      if (!isRefusal(responseSchema(op, '422'))) fail(`${id}: takes a body, so 422 must answer a Refusal`);
      const takesCaller = body.properties?.caller?.$ref === '#/components/schemas/CallerRef' && body.required?.includes('caller');
      if (NO_CALLER.has(id)) {
        if (body.properties?.caller) fail(`${id}: a pre-session operation takes no caller`);
      } else {
        if (!takesCaller) fail(`${id}: a caller-scoped operation requires caller (CallerRef)`);
        // logout answers 204 for any well-formed caller; every other caller-scoped operation can end on session_ended.
        if (id !== 'logout' && responseSchema(op, '403') !== 'Refusal') fail(`${id}: must declare 403 session_ended`);
        if (id === 'logout' && op.responses['403']) fail('logout never answers session_ended');
      }
    }
  }
  if (failures === before) ok(`${dir}: all ${n} operations declare the transport answers and carry the caller as required`);
  return { checked, failures };
}
