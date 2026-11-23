// A reference processor for the observation processing contract (contracts/observation-processing/v1): the rules of
// its README sections 2 to 5 as code. The validator replays every fixture through it, and the fixture generator in
// scripts/ uses it to fill in expected outputs. It is a specification aid, not a Backend: no storage, no clock.
import { createHash } from 'node:crypto';

export const PAYLOAD_TYPES = {
  0x00: 'REQUEST', 0x01: 'RESPONSE', 0x02: 'TEXT_MESSAGE', 0x03: 'ACK', 0x04: 'ADVERT', 0x05: 'GROUP_TEXT',
  0x06: 'GROUP_DATA', 0x07: 'ANON_REQUEST', 0x08: 'PATH', 0x09: 'TRACE', 0x0a: 'MULTIPART', 0x0b: 'CONTROL',
  0x0f: 'RAW_CUSTOM',
};
const TRACE = 0x09;
const MAX_PATH_BYTES = 64;
const DEVICE_TIME_FLOOR = 1735689600; // 2025-01-01T00:00:00Z
const DEVICE_TIME_AHEAD_S = 60;
export const REASONS = ['retained', 'stub', 'not_a_packet', 'malformed', 'origin_mismatch', 'unparseable', 'duplicate_report', 'failed'];

export const payloadTypeName = (t) => PAYLOAD_TYPES[t] ?? `UNKNOWN_0x${t.toString(16).padStart(2, '0')}`;

// Section 3: the packet framing. Null for anything truncated or reserved.
export function parsePacket(bytes) {
  if (bytes.length < 2) return null;
  const header = bytes[0];
  const routeType = header & 0x03;
  const payloadType = (header >> 2) & 0x0f;
  let offset = 1;
  if (routeType === 0 || routeType === 3) {
    if (bytes.length < offset + 4) return null;
    offset += 4;
  }
  if (bytes.length < offset + 1) return null;
  const pathByte = bytes[offset];
  offset += 1;
  const hashMode = (pathByte >> 6) & 0x03;
  if (hashMode === 3) return null;
  const hopCount = pathByte & 0x3f;
  const pathLen = hopCount * (hashMode + 1);
  if (pathLen > MAX_PATH_BYTES || bytes.length < offset + pathLen) return null;
  offset += pathLen;
  if (offset >= bytes.length) return null;
  return { routeType, payloadType, pathByte, hopCount, payload: bytes.subarray(offset) };
}

// Section 3: packet identity, independent of route, transport codes and path (except TRACE's path byte).
export function packetId(parsed) {
  const h = createHash('sha256');
  h.update(Buffer.from([parsed.payloadType]));
  if (parsed.payloadType === TRACE) h.update(Buffer.from([parsed.pathByte & 0xff, parsed.pathByte >> 8]));
  h.update(parsed.payload);
  return h.digest('hex').slice(0, 16).toUpperCase();
}

const HEX = /^([0-9a-fA-F]{2})*$/;
const NUMERIC = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && NUMERIC.test(v) ? Number(v) : null);
const epochS = (iso) => Date.parse(iso) / 1000;

// Section 2: the two payload formats. Each returns { observer_key, outcome } or the extracted reception fields.
const ADAPTERS = {
  observer_envelope: {
    observerKey(topic) {
      const parts = topic.split('/');
      return parts.length >= 4 && parts[parts.length - 2] ? parts[parts.length - 2] : null;
    },
    extract(topic, payload, receivedAt, observerKey) {
      if (!topic.endsWith('/packets') && !topic.endsWith('/raw')) return { skip: 'not_a_packet' };
      let env;
      try { env = JSON.parse(payload.toString('utf8')); } catch { return { skip: 'malformed' }; }
      if (!env || typeof env !== 'object' || Array.isArray(env)) return { skip: 'malformed' };
      if (env.direction === 'tx') return { skip: 'not_a_packet' };
      const key = ['data', 'raw_data', 'raw'].find((k) => k in env);
      const hex = key === undefined ? undefined : env[key];
      if (typeof hex !== 'string' || !HEX.test(hex)) return { skip: 'malformed' };
      if (typeof env.origin_id === 'string' && env.origin_id.trim() && observerKey !== null
          && env.origin_id.trim().toLowerCase() !== observerKey.trim().toLowerCase()) return { skip: 'origin_mismatch' };
      const rssi = num('RSSI' in env ? env.RSSI : env.rssi);
      const snr = num('SNR' in env ? env.SNR : env.snr);
      const tsRaw = typeof env.ts === 'boolean' ? null : num(env.ts);
      const ts = tsRaw === null ? null : Math.trunc(tsRaw);
      const trusted = ts !== null && ts >= DEVICE_TIME_FLOOR && ts <= epochS(receivedAt) + DEVICE_TIME_AHEAD_S ? ts : null;
      return { bytes: Buffer.from(hex, 'hex'), rssi: rssi === 0 ? null : rssi, snr, device_observed_at: trusted };
    },
  },
  raw_hex: {
    observerKey(topic) {
      const parts = topic.split('/');
      return parts.length >= 2 && parts[parts.length - 1] ? parts[parts.length - 1] : null;
    },
    extract(topic, payload) {
      if (payload.some((b) => b > 0x7f)) return { skip: 'malformed' };
      const text = payload.toString('ascii').trim();
      if (!text || !HEX.test(text)) return { skip: 'malformed' };
      return { bytes: Buffer.from(text, 'hex'), rssi: null, snr: null, device_observed_at: null };
    },
  },
};
export const ADAPTER_NAMES = Object.keys(ADAPTERS);

const hourOf = (iso) => `${iso.slice(0, 13)}:00:00Z`;

// Sections 4 and 5: process captures in capture_id order, in steps; a crashed step leaves no trace. Returns the
// committed state: outcomes, packets, receptions and hours, each sorted as the README says.
export function process(sources, captures, steps = [{ take: captures.length }]) {
  const sorted = [...captures].sort((a, b) => a.capture_id - b.capture_id);
  let state = { outcomes: [], packets: new Map(), receptions: [] };
  const done = new Set();
  for (const step of steps) {
    const pending = sorted.filter((c) => !done.has(c.capture_id)).slice(0, step.take);
    const next = { outcomes: [...state.outcomes], packets: new Map([...state.packets].map(([k, v]) => [k, { ...v }])), receptions: [...state.receptions] };
    for (const c of pending) next.outcomes.push(processOne(sources[c.source], c, next));
    if (!step.crash) {
      state = next;
      for (const c of pending) done.add(c.capture_id);
    }
  }
  return snapshot(state);
}

function processOne(source, c, st) {
  const out = (outcome, reason) => (reason ? { capture_id: c.capture_id, outcome, reason } : { capture_id: c.capture_id, outcome });
  if (c.stub) return out('skipped', 'stub');
  if (c.retained) return out('skipped', 'retained');
  const adapter = ADAPTERS[source?.adapter];
  if (!adapter) throw new Error(`source ${c.source} names no known adapter`); // validated with the source, never here
  const observerKey = adapter.observerKey(c.topic);
  const x = adapter.extract(c.topic, Buffer.from(c.payload_b64, 'base64'), c.received_at, observerKey);
  if (x.skip) return out('skipped', x.skip);
  const parsed = parsePacket(x.bytes);
  if (!parsed) return out('skipped', 'unparseable');
  const id = packetId(parsed);
  // The packet is recorded as seen before the duplicate check: a repeated report still moves last_seen_at.
  const p = st.packets.get(id);
  if (!p) st.packets.set(id, { packet_id: id, packet_type: payloadTypeName(parsed.payloadType), first_seen_at: c.received_at, last_seen_at: c.received_at });
  else if (c.received_at > p.last_seen_at) p.last_seen_at = c.received_at;
  if (x.device_observed_at !== null && st.receptions.some((r) => r.packet_id === id && r.source === c.source && r.observer_key === observerKey
      && r.device_observed_at === x.device_observed_at && r.rssi === x.rssi && r.snr === x.snr)) return out('skipped', 'duplicate_report');
  st.receptions.push({
    capture_id: c.capture_id, packet_id: id, source: c.source, observer_key: observerKey, received_at: c.received_at,
    device_observed_at: x.device_observed_at, rssi: x.rssi, snr: x.snr, hop_count: parsed.hopCount, route_type: parsed.routeType,
  });
  return out('reception');
}

// Section 5: the hourly aggregate, a fold over receptions. Receptions with no observer are not folded.
export function hours(receptions) {
  const m = new Map();
  for (const r of receptions) {
    if (r.observer_key === null) continue;
    const k = JSON.stringify([r.source, r.observer_key, hourOf(r.received_at)]);
    const h = m.get(k) ?? { source: r.source, observer_key: r.observer_key, hour: hourOf(r.received_at), receptions: 0, rssi_sum: 0, rssi_count: 0, snr_sum: 0, snr_count: 0 };
    h.receptions += 1;
    if (r.rssi !== null) { h.rssi_sum += r.rssi; h.rssi_count += 1; }
    if (r.snr !== null) { h.snr_sum += r.snr; h.snr_count += 1; }
    m.set(k, h);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...m.values()].sort((a, b) => cmp(a.source, b.source) || cmp(a.observer_key, b.observer_key) || cmp(a.hour, b.hour));
}

function snapshot(st) {
  const receptions = [...st.receptions].sort((a, b) => a.capture_id - b.capture_id);
  return {
    outcomes: [...st.outcomes].sort((a, b) => a.capture_id - b.capture_id),
    packets: [...st.packets.values()].sort((a, b) => (a.packet_id < b.packet_id ? -1 : 1)),
    receptions,
    hours: hours(receptions),
  };
}
