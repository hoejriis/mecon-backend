import {
  clearQuarantine,
  discardPreviousGeneration,
  latestVersion,
  MIGRATIONS,
  QUARANTINE_MESSAGE,
  ROLLBACK_GUIDANCE,
  runMigrations,
  type KvStore,
  type Migration,
} from './migrations';

/** In-memory fake with optional fault injection, holding only synthetic values. */
class FakeKv implements KvStore {
  data = new Map<string, unknown>();
  failPutAfter: number | null = null; // throw on the Nth put from now
  failPutKey: RegExp | null = null;
  puts: string[] = [];
  async get(k: string) {
    return this.data.has(k) ? structuredClone(this.data.get(k)) : undefined;
  }
  async put(k: string, v: unknown) {
    if (this.failPutKey?.test(k)) throw new Error('disk full');
    if (this.failPutAfter !== null && this.failPutAfter-- <= 0) throw new Error('interrupted');
    this.puts.push(k);
    this.data.set(k, structuredClone(v));
  }
  async delete(k: string) {
    this.data.delete(k);
  }
  async keys(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  snapshot() {
    return JSON.stringify([...this.data].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
}

const seed = (kv: FakeKv, version: number, generation: number, entries: Record<string, unknown>) => {
  kv.data.set('meta/schema', { version, generation, previousGeneration: null });
  for (const [k, v] of Object.entries(entries)) kv.data.set(`g${generation}/${k}`, v);
};

// A 1 -> 2 migration over synthetic records, to exercise real copy/transform/verify.
const upper: Migration = {
  from: 1,
  to: 2,
  migrate: (e) => new Map([...e].map(([k, v]) => [k, { ...(v as object), v: 2 }])),
  verify: (_b, a) => {
    for (const v of a.values()) if ((v as { v?: number }).v !== 2) throw new Error('bad shape');
  },
};
const CHAIN = [...MIGRATIONS, upper];

describe('current registry', () => {
  it('is version 0 -> 1 and a no-op', async () => {
    expect(latestVersion()).toBe(1);
    const kv = new FakeKv();
    const r = await runMigrations(kv);
    expect(r).toEqual({ status: 'migrated', version: 1 });
    expect([...kv.data.keys()]).toEqual(['meta/schema']); // stores no content
    expect(await runMigrations(kv)).toEqual({ status: 'current', version: 1 });
  });
});

describe('compatible migration', () => {
  it('copies, migrates, verifies, switches; the old generation is kept for rollback', async () => {
    const kv = new FakeKv();
    seed(kv, 1, 0, { 'draft/1': { id: 1 }, 'attempt/9': { id: 9 } });
    const r = await runMigrations(kv, CHAIN);
    expect(r).toEqual({ status: 'migrated', version: 2 });
    expect(await kv.get('meta/schema')).toEqual({ version: 2, generation: 1, previousGeneration: 0 });
    expect(await kv.get('g1/draft/1')).toEqual({ id: 1, v: 2 });
    expect(await kv.get('g0/draft/1')).toEqual({ id: 1 }); // untouched
    expect(await kv.get('meta/quarantine')).toBeUndefined();
    // the switch is the LAST write
    expect(kv.puts.at(-1)).toBe('meta/schema');
    await discardPreviousGeneration(kv);
    expect(await kv.get('g0/draft/1')).toBeUndefined();
    expect(await kv.get('g1/draft/1')).toEqual({ id: 1, v: 2 });
  });

  it('already current: no writes', async () => {
    const kv = new FakeKv();
    seed(kv, 2, 3, { a: { v: 2 } });
    const before = kv.snapshot();
    expect(await runMigrations(kv, CHAIN)).toEqual({ status: 'current', version: 2 });
    expect(kv.snapshot()).toBe(before);
  });
});

describe('incompatible (newer) schema', () => {
  it('leaves data and marker untouched, writes a quarantine marker, says nothing was deleted', async () => {
    const kv = new FakeKv();
    seed(kv, 7, 4, { 'draft/1': { id: 1 } });
    const before = kv.snapshot();
    const r = await runMigrations(kv, CHAIN);
    expect(r).toMatchObject({ status: 'quarantined', reason: 'newer-schema', message: QUARANTINE_MESSAGE, guidance: ROLLBACK_GUIDANCE });
    expect(QUARANTINE_MESSAGE).toBe("This version can't read your local data; nothing was deleted.");
    expect(await kv.get('meta/quarantine')).toMatchObject({ reason: 'newer-schema', foundVersion: 7, knownVersion: 2 });
    // everything except the quarantine marker is byte-identical
    kv.data.delete('meta/quarantine');
    expect(kv.snapshot()).toBe(before);
  });

  it('the marker clears itself once a build that knows the schema runs', async () => {
    const kv = new FakeKv();
    seed(kv, 2, 1, { a: { v: 2 } });
    kv.data.set('meta/quarantine', { reason: 'newer-schema', foundVersion: 2, knownVersion: 1 });
    expect(await runMigrations(kv, CHAIN)).toEqual({ status: 'current', version: 2 });
    expect(await kv.get('meta/quarantine')).toBeUndefined();
  });

  it('an unreadable schema marker is quarantined, not overwritten', async () => {
    const kv = new FakeKv();
    kv.data.set('meta/schema', 'garbage');
    kv.data.set('g0/x', { id: 1 });
    expect(await runMigrations(kv)).toMatchObject({ status: 'quarantined', reason: 'corrupt-marker' });
    expect(await kv.get('meta/schema')).toBe('garbage');
    expect(await kv.get('g0/x')).toEqual({ id: 1 });
  });
});

describe('failure rolls back', () => {
  it('a throwing migration leaves the live generation untouched and quarantines', async () => {
    const kv = new FakeKv();
    seed(kv, 1, 0, { 'draft/1': { id: 1 } });
    const before = kv.snapshot();
    const boom: Migration = { from: 1, to: 2, migrate: () => { throw new Error('boom'); } };
    const r = await runMigrations(kv, [...MIGRATIONS, boom]);
    expect(r).toMatchObject({ status: 'quarantined', reason: 'migration-failed' });
    expect(await kv.get('meta/schema')).toEqual({ version: 1, generation: 0, previousGeneration: null });
    expect(await kv.keys('g1/')).toEqual([]);
    expect(await kv.get('meta/quarantine')).toMatchObject({ reason: 'migration-failed', from: 1, to: 2, detail: 'boom' });
    kv.data.delete('meta/quarantine');
    expect(kv.snapshot()).toBe(before);
  });

  it('a failure part-way through writing the copy discards the copy and keeps the old data', async () => {
    const kv = new FakeKv();
    seed(kv, 1, 0, { a: { id: 1 }, b: { id: 2 }, c: { id: 3 } });
    kv.failPutAfter = 2; // third write into the copy fails
    const r = await runMigrations(kv, CHAIN);
    expect(r).toMatchObject({ status: 'quarantined', reason: 'migration-failed' });
    expect(await kv.get('meta/schema')).toEqual({ version: 1, generation: 0, previousGeneration: null });
    expect(await kv.keys('g1/')).toEqual([]);
    expect(await kv.keys('g0/')).toEqual(['g0/a', 'g0/b', 'g0/c']);
  });

  it('a failing verify (bad result) never switches', async () => {
    const kv = new FakeKv();
    seed(kv, 1, 0, { a: { id: 1 } });
    const bad: Migration = { ...upper, migrate: (e) => new Map(e) }; // forgets to upgrade records
    expect(await runMigrations(kv, [...MIGRATIONS, bad])).toMatchObject({ status: 'quarantined', reason: 'migration-failed' });
    expect((await kv.get('meta/schema')) as unknown).toMatchObject({ version: 1, generation: 0 });
  });

  it('a store that silently loses a written entry is caught by the read-back verification before the switch', async () => {
    const kv = new FakeKv();
    seed(kv, 1, 0, { a: { id: 1 }, b: { id: 2 } });
    const real = kv.put.bind(kv);
    kv.put = async (k, v) => { if (k !== 'g1/b') await real(k, v); }; // drops one write without an error
    expect(await runMigrations(kv, CHAIN)).toMatchObject({ status: 'quarantined', reason: 'migration-failed' });
    expect(await kv.get('meta/schema')).toEqual({ version: 1, generation: 0, previousGeneration: null });
    expect(await kv.keys('g1/')).toEqual([]);
    expect(await kv.keys('g0/')).toEqual(['g0/a', 'g0/b']);
  });

  it('a failing switch write leaves the old marker in force', async () => {
    const kv = new FakeKv();
    seed(kv, 1, 0, { a: { id: 1 } });
    kv.failPutKey = /^meta\/schema$/;
    expect(await runMigrations(kv, CHAIN)).toMatchObject({ status: 'quarantined' });
    expect(await kv.get('meta/schema')).toEqual({ version: 1, generation: 0, previousGeneration: null });
    expect(await kv.keys('g1/')).toEqual([]);
  });

  it('a failed migration is not retried every boot, but is by a build with a newer schema or an explicit clear', async () => {
    const kv = new FakeKv();
    seed(kv, 1, 0, { a: { id: 1 } });
    let calls = 0;
    const flaky: Migration = { from: 1, to: 2, migrate: (e) => { if (calls++ === 0) throw new Error('once'); return new Map([...e].map(([k, v]) => [k, { ...(v as object), v: 2 }])); } };
    const chain = [...MIGRATIONS, flaky];
    expect(await runMigrations(kv, chain)).toMatchObject({ status: 'quarantined' });
    expect(await runMigrations(kv, chain)).toMatchObject({ status: 'quarantined' });
    expect(calls).toBe(1);
    await clearQuarantine(kv);
    expect(await runMigrations(kv, chain)).toEqual({ status: 'migrated', version: 2 });
  });
});

describe('interrupted run', () => {
  it('a half-built copy from a killed run is discarded and never read as live', async () => {
    const kv = new FakeKv();
    seed(kv, 1, 0, { a: { id: 1 } });
    kv.data.set('g1/a', { id: 'STALE-PARTIAL' }); // left by a run killed before the switch
    kv.data.set('g1/zzz', { id: 'ORPHAN' });
    expect(await runMigrations(kv, CHAIN)).toEqual({ status: 'migrated', version: 2 });
    expect(await kv.get('g1/a')).toEqual({ id: 1, v: 2 });
    expect(await kv.get('g1/zzz')).toBeUndefined();
  });

  it('killed after the copy but before the switch: the old marker still serves the old data', async () => {
    const kv = new FakeKv();
    seed(kv, 1, 0, { a: { id: 1 } });
    const real = kv.put.bind(kv);
    kv.put = async (k, v) => { if (k === 'meta/schema') throw new Error('killed'); return real(k, v); };
    await runMigrations(kv, CHAIN);
    const marker = (await kv.get('meta/schema')) as { version: number; generation: number };
    expect(marker).toMatchObject({ version: 1, generation: 0 });
    expect(await kv.get('g0/a')).toEqual({ id: 1 });
  });
});

describe('chain validation', () => {
  it('rejects gaps and multi-step migrations', async () => {
    await expect(runMigrations(new FakeKv(), [{ from: 1, to: 2, migrate: (e) => e }])).rejects.toThrow(/start at 0/);
    await expect(runMigrations(new FakeKv(), [{ from: 0, to: 2, migrate: (e) => e }])).rejects.toThrow(/one version/);
  });
});
