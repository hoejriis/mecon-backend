// Regenerates the synthetic lease fixtures from the TEST-ONLY keypair in
// reader-api/v1/test-only/lease-test-keypair.json. Ed25519 is deterministic,
// so the output is stable. Usage:
//   node scripts/gen-lease-fixtures.mjs --new-keypair   (replace the test keypair)
//   node scripts/gen-lease-fixtures.mjs                  (write the fixtures)
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../reader-api/v1/', import.meta.url);
const kpPath = new URL('test-only/lease-test-keypair.json', dir);
const b64u = (b) => Buffer.from(b).toString('base64url');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

if (process.argv.includes('--new-keypair')) {
  const seed = randomBytes(32);
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
  const kp = JSON.parse(readFileSync(kpPath, 'utf8'));
  kp.private_key_seed_hex = seed.toString('hex');
  kp.public_key_base64url = b64u(pub);
  writeFileSync(kpPath, JSON.stringify(kp, null, 2) + '\n');
}
void generateKeyPairSync;

const kp = JSON.parse(readFileSync(kpPath, 'utf8'));
const priv = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, Buffer.from(kp.private_key_seed_hex, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});

const canon = (v) =>
  Array.isArray(v)
    ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
      : JSON.stringify(v);

export const payload = {
  lease_id: 'lease_synthetic_1',
  user_id: 'usr_synthetic_alice',
  issued_at: '2030-01-01T00:00:00Z',
  expires_at: '2030-01-08T00:00:00Z',
  key_id: kp.key_id,
  contract_version: '1.0',
  identities: [{ identity_id: 'idn_synthetic_a', operations: ['receive', 'send.direct', 'send.channel'] }],
  devices: ['dev_synthetic_c1'],
  channels: ['chn_synthetic_1'],
};
const body = Buffer.from(canon(payload), 'utf8');
const signature = sign(null, Buffer.concat([Buffer.from('MECON-LEASE-1\0', 'latin1'), body]), priv);
const token = `${b64u(body)}.${b64u(signature)}`;

const write = (name, obj) => writeFileSync(new URL(`fixtures/${name}`, dir), JSON.stringify(obj) + '\n');
write('lease-issued.json', { lease: token, expires_at: payload.expires_at });
write('lease-keys.json', {
  keys: [
    {
      key_id: kp.key_id,
      algorithm: 'Ed25519',
      public_key: kp.public_key_base64url,
      status: 'active',
      not_before: '2029-12-01T00:00:00Z',
      not_after: null,
    },
  ],
  as_of: '2030-01-01T00:00:00Z',
});
console.log('wrote lease fixtures');
