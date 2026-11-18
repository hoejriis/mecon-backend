/**
 * Versioned local-storage migration runner (for the encrypted cache, which
 * does not exist yet). It works over an abstract async key-value store, so the
 * same logic runs on IndexedDB in the app and on an in-memory fake in tests.
 *
 * Layout in the store:
 *   meta/schema      { version, generation, previousGeneration }  the switch
 *   meta/quarantine  { reason, ... }                              set on failure / newer schema
 *   g<N>/<key>       the data of generation N
 *
 * A migration never edits live data. It copies generation N to N+1, applies
 * the ordered steps to the copy, verifies, and only then overwrites the single
 * `meta/schema` key (the atomic switch). Anything before the switch leaves the
 * live generation byte-for-byte untouched; the half-built copy is discarded.
 * The previous generation is kept after a switch until `discardPreviousGeneration`.
 * Nothing here holds message content or secrets: it moves opaque values.
 */

export interface KvStore {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export type Entries = Map<string, unknown>;

export interface Migration {
  from: number;
  to: number;
  /** Returns the migrated entries (a new map). Must not mutate its input's values. */
  migrate(entries: Entries): Entries | Promise<Entries>;
  /** Throws if the migrated entries are not acceptable. */
  verify?(before: Entries, after: Entries): void | Promise<void>;
}

/** Version 0 (nothing stored) to 1 (the first schema marker): changes no data. */
export const MIGRATIONS: readonly Migration[] = [{ from: 0, to: 1, migrate: (e) => new Map(e) }];

export const latestVersion = (ms: readonly Migration[] = MIGRATIONS): number => ms[ms.length - 1]?.to ?? 0;

export const QUARANTINE_MESSAGE = "This version can't read your local data; nothing was deleted.";
export const ROLLBACK_GUIDANCE =
  'Your local data is untouched. Go back to the Reader version you used before (or reload to get the latest one), ' +
  'or sign out of this device only if you accept losing unsent drafts you can no longer open.';

const SCHEMA_KEY = 'meta/schema';
const QUARANTINE_KEY = 'meta/quarantine';
const dataPrefix = (g: number) => `g${g}/`;

interface SchemaMarker {
  version: number;
  generation: number;
  previousGeneration: number | null;
}
export interface QuarantineMarker {
  reason: 'newer-schema' | 'migration-failed' | 'corrupt-marker';
  foundVersion: number | null;
  knownVersion: number;
  from?: number;
  to?: number;
  /** Error text only; never data values. */
  detail?: string;
}

export type MigrationResult =
  | { status: 'fresh' | 'current' | 'migrated'; version: number }
  | { status: 'quarantined'; reason: QuarantineMarker['reason']; message: string; guidance: string };

function isMarker(v: unknown): v is SchemaMarker {
  const m = v as SchemaMarker | null;
  return (
    !!m &&
    typeof m === 'object' &&
    Number.isInteger(m.version) &&
    m.version >= 0 &&
    Number.isInteger(m.generation) &&
    m.generation >= 0
  );
}

async function readGeneration(store: KvStore, gen: number): Promise<Entries> {
  const prefix = dataPrefix(gen);
  const out: Entries = new Map();
  for (const k of await store.keys(prefix)) out.set(k.slice(prefix.length), await store.get(k));
  return out;
}

async function dropGeneration(store: KvStore, gen: number): Promise<void> {
  for (const k of await store.keys(dataPrefix(gen))) await store.delete(k);
}

const quarantined = (q: QuarantineMarker): MigrationResult => ({
  status: 'quarantined',
  reason: q.reason,
  message: QUARANTINE_MESSAGE,
  guidance: ROLLBACK_GUIDANCE,
});

function validateChain(ms: readonly Migration[]) {
  ms.forEach((m, i) => {
    if (m.to !== m.from + 1) throw new Error(`migration ${m.from}->${m.to} must advance one version`);
    if (m.from !== i) throw new Error(`migrations must start at 0 and have no gap (found ${m.from} at ${i})`);
  });
}

export async function runMigrations(store: KvStore, migrations: readonly Migration[] = MIGRATIONS): Promise<MigrationResult> {
  validateChain(migrations);
  const known = latestVersion(migrations);

  const rawMarker = await store.get(SCHEMA_KEY);
  const quarantine = (await store.get(QUARANTINE_KEY)) as QuarantineMarker | undefined;
  let marker: SchemaMarker | null = null;
  if (rawMarker !== undefined) {
    if (!isMarker(rawMarker)) {
      const q: QuarantineMarker = { reason: 'corrupt-marker', foundVersion: null, knownVersion: known };
      await store.put(QUARANTINE_KEY, q);
      return quarantined(q);
    }
    marker = rawMarker;
  }

  if (marker && marker.version > known) {
    const q: QuarantineMarker = { reason: 'newer-schema', foundVersion: marker.version, knownVersion: known };
    await store.put(QUARANTINE_KEY, q); // data and schema marker stay as they are
    return quarantined(q);
  }
  // A failed migration stays quarantined until this build knows a newer schema (a fix), or the user retries.
  if (quarantine?.reason === 'migration-failed' && quarantine.knownVersion === known) return quarantined(quarantine);
  if (quarantine?.reason === 'corrupt-marker') return quarantined(quarantine);

  const version = marker?.version ?? 0;
  const generation = marker?.generation ?? 0;
  if (quarantine) await store.delete(QUARANTINE_KEY); // newer-schema no longer applies, or an older failure of another build

  // An interrupted earlier run left a half-built copy: it was never live.
  await dropGeneration(store, generation + 1);

  if (version === known) {
    return marker ? { status: 'current', version } : await createFresh(store, known);
  }

  const next = generation + 1;
  try {
    const before = await readGeneration(store, generation);
    let entries: Entries = before;
    for (const m of migrations.slice(version)) {
      const out = await m.migrate(new Map(entries));
      await m.verify?.(entries, out);
      entries = out;
    }
    for (const [k, v] of entries) await store.put(dataPrefix(next) + k, v);
    // Verify what was actually written, not just the in-memory result.
    const written = await readGeneration(store, next);
    if (written.size !== entries.size) throw new Error('verification: written entry count differs');
    for (const [k, v] of entries) {
      if (!written.has(k) || JSON.stringify(written.get(k)) !== JSON.stringify(v)) throw new Error('verification: entry differs');
    }
    // The switch: one write. Before it, nothing about the live data changed.
    const switched: SchemaMarker = { version: known, generation: next, previousGeneration: marker ? generation : null };
    await store.put(SCHEMA_KEY, switched);
    return { status: 'migrated', version: known };
  } catch (err) {
    const q: QuarantineMarker = {
      reason: 'migration-failed',
      foundVersion: version,
      knownVersion: known,
      from: version,
      to: known,
      detail: err instanceof Error ? err.message : 'unknown error',
    };
    try {
      await dropGeneration(store, next); // roll back: discard the copy, live data was never touched
    } catch {
      /* a leftover copy is discarded by the next run */
    }
    try {
      await store.put(QUARANTINE_KEY, q);
    } catch {
      /* the schema marker still names the untouched generation */
    }
    return quarantined(q);
  }
}

async function createFresh(store: KvStore, known: number): Promise<MigrationResult> {
  await store.put(SCHEMA_KEY, { version: known, generation: 0, previousGeneration: null } satisfies SchemaMarker);
  return { status: 'fresh', version: known };
}

/** After the new version has run fine, free the generation kept for rollback. */
export async function discardPreviousGeneration(store: KvStore): Promise<void> {
  const m = await store.get(SCHEMA_KEY);
  if (!isMarker(m) || m.previousGeneration === null) return;
  await dropGeneration(store, m.previousGeneration);
  await store.put(SCHEMA_KEY, { ...m, previousGeneration: null });
}

/** Explicit retry after a failed migration (for example after the user updated). */
export async function clearQuarantine(store: KvStore): Promise<void> {
  await store.delete(QUARANTINE_KEY);
}
