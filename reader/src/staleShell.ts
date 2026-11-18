export const VERSION_URL = '/version.json';
export const REPAIR_KEY = 'mecon.reader.stale-repair';
export const SW_UPDATE_WAIT_MS = 3000;

export type StaleOutcome =
  | 'skipped-null-commit'
  | 'skipped-unreadable'
  | 'fresh'
  | 'already-attempted'
  | 'repaired';

export interface StaleDeps {
  bundleCommit: string | null;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  serviceWorker?: Pick<ServiceWorkerContainer, 'getRegistrations'> | null;
  cacheStorage?: Pick<CacheStorage, 'keys' | 'delete'> | null;
  reload: () => void;
  wait?: (ms: number) => Promise<void>;
}

async function fetchServedCommit(f: typeof fetch): Promise<string | null | undefined> {
  try {
    const res = await f(VERSION_URL, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'commit' in body) {
      const c = (body as { commit: unknown }).commit;
      if (c === null || typeof c === 'string') return c;
    }
  } catch {
    /* offline, or the dev server answered with HTML */
  }
  return undefined;
}

/**
 * Rule 2: a service-worker shell can run a pre-deploy build for days. The
 * deploy publishes `/version.json` next to the bundle; when it names a
 * different commit than this bundle, repair once per served commit: ask the
 * workers to update, wait, then unregister them, drop every cache and reload.
 * A null commit on either side (local build) never triggers anything.
 */
export async function checkStaleShell(deps: StaleDeps): Promise<StaleOutcome> {
  const { bundleCommit } = deps;
  if (bundleCommit === null) return 'skipped-null-commit';
  const served = await fetchServedCommit(deps.fetchImpl ?? fetch);
  if (served === undefined) return 'skipped-unreadable';
  if (served === null) return 'skipped-null-commit';
  if (served === bundleCommit) return 'fresh';

  try {
    if (deps.storage?.getItem(REPAIR_KEY) === served) return 'already-attempted';
    deps.storage?.setItem(REPAIR_KEY, served);
  } catch {
    /* storage blocked: still repair, accept the reload-loop risk is bounded by the next load comparing again */
  }

  const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const regs = (await deps.serviceWorker?.getRegistrations()) ?? [];
  if (regs.length > 0) {
    await Promise.allSettled(regs.map((r) => r.update()));
    await wait(SW_UPDATE_WAIT_MS);
    await Promise.allSettled(regs.map((r) => r.unregister()));
  }
  if (deps.cacheStorage) {
    const names = await deps.cacheStorage.keys();
    await Promise.allSettled(names.map((n) => deps.cacheStorage!.delete(n)));
  }
  deps.reload();
  return 'repaired';
}

/** Browser wiring for `checkStaleShell`. */
export function runStaleShellCheck(bundleCommit: string | null): Promise<StaleOutcome> {
  let storage: Storage | null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return checkStaleShell({
    bundleCommit,
    storage,
    serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : null,
    cacheStorage: 'caches' in window ? window.caches : null,
    reload: () => window.location.reload(),
  });
}
