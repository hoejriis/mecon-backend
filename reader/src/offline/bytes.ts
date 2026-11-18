/** Small byte helpers shared by the offline modules. No secrets are kept here. */

export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s: string): Bytes => encoder.encode(s) as Bytes;
export const fromUtf8 = (b: Uint8Array): string => decoder.decode(b);

export function b64uEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Strict base64url without padding. Throws on any other character. */
export function b64uDecode(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('not base64url');
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out as Bytes;
}

export const randomBytes = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n)) as Bytes;

export const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out as Bytes;
};

/**
 * Canonical JSON as the lease contract defines it: object keys sorted by code
 * point at every level, no insignificant whitespace. Used by tests (and by any
 * Backend stand-in) to build a lease payload; the Reader verifies the bytes it
 * received and never re-serializes them.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
