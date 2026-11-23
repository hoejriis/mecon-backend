// Writes the observation processing fixtures (contracts/observation-processing/v1/fixtures A to D) from the
// captures below, with the expected outputs filled in by the reference processor. Run from contracts/:
//   node scripts/gen-observation-processing-fixtures.mjs
// Review the diff by hand: the reference is a specification aid, and a second implementation replaying the same
// fixtures is what checks it.
import { writeFileSync } from 'node:fs';
import { process as run, REASONS } from '../observation-processing-reference.mjs';

const DIR = 'observation-processing/v1/fixtures';
const b64 = (s) => Buffer.from(s).toString('base64');
const env = (o) => b64(JSON.stringify(o));
const SOURCES = { 'own-broker': { adapter: 'observer_envelope' }, 'open-feed': { adapter: 'raw_hex' } };
const T0 = 1767225600; // 2026-01-01T00:00:00Z

// Packets, as hex. Header: version << 6 | payload type << 2 | route type. Path byte: hash mode << 6 | hops.
const GROUP_TEXT_DIRECT0 = '1500' + 'a1b2c3d4e5f60718'; //           flood, no hops
const GROUP_TEXT_TWO_HOPS = '1502' + '1122' + 'a1b2c3d4e5f60718'; // the same packet, relayed twice
const ADVERT_TRANSPORT = '10' + '34120000' + '01' + 'aa' + '0102030405060708090a'; // transport flood, codes, one hop
const TRACE_ONE = '26' + '01' + 'bb' + 'c0ffee00'; //                    direct TRACE, path byte 0x01
const TRACE_TWO = '26' + '02' + 'bbcc' + 'c0ffee00'; //                  same payload, path byte 0x02
const RESERVED_MODE = '15' + 'c1' + 'aabbccdd' + '00ff'; //            path hash mode 3 is reserved; long enough to frame otherwise

const cap = (capture_id, source, topic, payload_b64, received_at, extra = {}) =>
  ({ capture_id, source, topic, payload_b64, retained: false, received_at, ...extra });

const A = [
  cap(1, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: GROUP_TEXT_DIRECT0, RSSI: -90, SNR: 7.5, ts: T0 - 1 }), '2026-01-01T00:00:00.120Z'),
  cap(2, 'own-broker', 'meshcore/AB12/obs-2/packets', env({ data: GROUP_TEXT_TWO_HOPS, RSSI: '-101', SNR: '-3.25', ts: T0 }), '2026-01-01T00:00:00.480Z'),
  cap(3, 'own-broker', 'meshcore/AB12/obs-1/status', env({ status: 'online' }), '2026-01-01T00:00:01.000Z'),
  cap(4, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: GROUP_TEXT_DIRECT0, RSSI: -90, SNR: 7.5 }), '2026-01-01T00:00:01.100Z', { retained: true }),
  { capture_id: 5, source: 'own-broker', topic: 'meshcore/AB12/obs-1/packets', stub: { size: 70000, content_hash: 'ab'.repeat(32) }, retained: false, received_at: '2026-01-01T00:00:01.200Z' },
  cap(6, 'own-broker', 'meshcore/AB12/obs-1/packets', b64('not json'), '2026-01-01T00:00:01.300Z'),
  cap(7, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ direction: 'tx', data: GROUP_TEXT_DIRECT0 }), '2026-01-01T00:00:01.400Z'),
  cap(8, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: GROUP_TEXT_DIRECT0, origin_id: 'obs-7' }), '2026-01-01T00:00:01.500Z'),
  cap(9, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: '15' }), '2026-01-01T00:00:01.600Z'),
  cap(10, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: RESERVED_MODE }), '2026-01-01T00:00:01.700Z'),
  cap(11, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ raw: 'zz' }), '2026-01-01T00:00:01.800Z'),
  cap(12, 'open-feed', 'packets/obs-9', b64(ADVERT_TRANSPORT + '\n'), '2026-01-01T00:00:02.000Z'),
  cap(13, 'own-broker', 'meshcore/AB12/obs-3/raw', env({ raw_data: ADVERT_TRANSPORT, rssi: 0, snr: 0, ts: T0 + 3600, origin_id: 'OBS-3' }), '2026-01-01T00:00:02.300Z'),
  cap(14, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: GROUP_TEXT_DIRECT0, ts: 1600000000 }), '2026-01-01T00:00:02.500Z'),
  // Retained and a stub: the stub decides, as a stub is never read further.
  { capture_id: 15, source: 'own-broker', topic: 'meshcore/AB12/obs-1/packets', stub: { size: 70000, content_hash: 'cd'.repeat(32) }, retained: true, received_at: '2026-01-01T00:00:02.600Z' },
  // A topic too short to name an observer: a reception with none, not folded into the hours.
  cap(16, 'own-broker', 'obs/packets', env({ data: ADVERT_TRANSPORT, RSSI: -77 }), '2026-01-01T00:00:02.700Z'),
];

const B = [
  cap(1, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: GROUP_TEXT_DIRECT0, RSSI: -88, SNR: 6, ts: T0 + 3595 }), '2026-01-01T00:59:59.900Z'),
  cap(2, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: GROUP_TEXT_DIRECT0, RSSI: -88, SNR: 6, ts: T0 + 3595 }), '2026-01-01T01:00:00.100Z'),
  cap(3, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: GROUP_TEXT_TWO_HOPS, RSSI: -95, SNR: 2.5, ts: T0 + 3595 }), '2026-01-01T01:00:00.200Z'),
  cap(4, 'own-broker', 'meshcore/AB12/obs-2/packets', env({ data: TRACE_ONE, RSSI: -70, SNR: 9 }), '2026-01-01T01:00:01.000Z'),
  cap(5, 'own-broker', 'meshcore/AB12/obs-2/packets', env({ data: TRACE_ONE, RSSI: -70, SNR: 9 }), '2026-01-01T01:00:01.100Z'),
  cap(6, 'own-broker', 'meshcore/AB12/obs-2/packets', env({ data: TRACE_TWO, RSSI: -71, SNR: 8, ts: T0 + 3601 }), '2026-01-01T01:00:01.200Z'),
  cap(7, 'open-feed', 'packets/obs-9', b64(GROUP_TEXT_DIRECT0), '2026-01-01T01:00:02.000Z'),
  // The same report as 6, the last capture of its packet: a repeated report still moves last_seen_at.
  cap(8, 'own-broker', 'meshcore/AB12/obs-2/packets', env({ data: TRACE_TWO, RSSI: -71, SNR: 8, ts: T0 + 3601 }), '2026-01-01T01:00:03.000Z'),
  // As 1 but for its SNR: a second hearing, not a repeat.
  cap(9, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: GROUP_TEXT_DIRECT0, RSSI: -88, SNR: 5, ts: T0 + 3595 }), '2026-01-01T01:00:04.000Z'),
];

const C = [
  cap(1, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: GROUP_TEXT_DIRECT0, RSSI: -90, SNR: 7, ts: T0 }), '2026-01-01T00:00:00.100Z'),
  cap(2, 'own-broker', 'meshcore/AB12/obs-2/packets', env({ data: GROUP_TEXT_TWO_HOPS, RSSI: -99, SNR: 1 }), '2026-01-01T00:00:00.200Z'),
  cap(3, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: ADVERT_TRANSPORT, RSSI: -80 }), '2026-01-01T00:00:00.300Z'),
  cap(4, 'own-broker', 'meshcore/AB12/obs-1/packets', env({ data: GROUP_TEXT_DIRECT0, RSSI: -90, SNR: 7, ts: T0 }), '2026-01-01T00:00:00.400Z'),
  cap(5, 'own-broker', 'meshcore/AB12/obs-2/packets', env({ data: GROUP_TEXT_TWO_HOPS, RSSI: -99, SNR: 1 }), '2026-01-01T00:00:00.500Z'),
  cap(6, 'open-feed', 'packets/obs-9', b64(ADVERT_TRANSPORT), '2026-01-01T00:00:00.600Z'),
];
const C_STEPS = [{ take: 2 }, { take: 3, crash: true }, { take: 3 }, { take: 5 }];

const fixture = (letter, title, captures, steps) => {
  const doc = { fixture: letter, title, kind: 'process', sources: SOURCES };
  if (steps) doc.steps = steps;
  doc.captures = captures;
  doc.expect = run(SOURCES, captures, steps);
  return doc;
};

const write = (name, doc) => {
  const lines = JSON.stringify(doc, null, 1).split('\n');
  writeFileSync(`${DIR}/${name}`, `${lines.join('\n')}\n`);
};

const a = fixture('A', 'One batch: two receptions of one packet, every way a capture is skipped, both payload formats', A);
const b = fixture('B', 'Repeated reports, separate receptions, TRACE identity and an hour boundary', B);
const c = fixture('C', 'A crash mid-run loses nothing and duplicates nothing', C, C_STEPS);
write('A-one-batch.json', a);
write('B-repeats-and-identity.json', b);
write('C-crash-and-replay.json', c);

const skipped = Object.fromEntries(REASONS.map((r) => [r, 0]));
let receptions = 0;
for (const f of [a, b]) for (const o of f.expect.outcomes) { if (o.outcome === 'reception') receptions++; else skipped[o.reason]++; }
write('D-counters-after-a-b.json', {
  fixture: 'D', title: 'The counters after A and B, nothing pending', kind: 'counters', after: ['A', 'B'],
  counters: { processed: receptions + Object.values(skipped).reduce((s, n) => s + n, 0), receptions, skipped, pending: 0, oldest_pending_ms: null },
});
console.log('wrote A to D');
