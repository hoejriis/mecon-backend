import { hasBlockers, type Blockers } from './update/guards';

export const VERSION_URL = '/version.json';
export const REPAIR_KEY = 'mecon.reader.stale-repair';
export const SW_UPDATE_WAIT_MS = 3000;
/**
 * Stands for "the host serves a build that has no /version.json": it answered
 * 404, or 200 text/html through its SPA fallback. A release from before the
 * file existed (the rollback target v0.1.0) looks like this, and a worker-held
 * shell of a newer build must still recover onto it.
 */
export const UNVERSIONED = 'unversioned';

export type StaleOutcome =
  | 'skipped-null-commit'
  | 'skipped-unreadable'
  | 'fresh'
  | 'already-attempted'
  | 'needs-confirmation'
  | 'activated-waiting'
  | 'repaired';

export interface StaleDeps {
  bundleCommit: string | null;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  serviceWorker?: Pick<ServiceWorkerContainer, 'getRegistrations'> | null;
  /** What a repair would interrupt. Absent means nothing can be lost. */
  getBlockers?: () => Blockers;
  /** Called when a newer build exists but a repair would lose something; the confirmed-update banner takes over. */
  onBlocked?: (blockers: Blockers) => void;
  /** Activate an already-downloaded waiting version (the normal, cache-preserving path). */
  activateWaiting?: () => boolean;
  cacheStorage?: Pick<CacheStorage, 'keys' | 'delete'> | null;
  reload: () => void;
  wait?: (ms: number) => Promise<void>;
}

async function fetchServedCommit(f: typeof fetch): Promise<string | null | undefined> {
  try {
    const res = await f(VERSION_URL, { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 404) return UNVERSIONED;
    if (!res.ok) return undefined;
    if ((res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) return UNVERSIONED;
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
 * different commit than this bundle, repair once per served commit, but only
 * when nothing can be lost (no drafts, no uncertain attempts, no BLE link),
 * checked before and again after the wait. Otherwise report
 * `needs-confirmation` and leave the user to the confirmed-update banner.
 * Repair asks the workers to update and waits; a downloaded waiting version is
 * activated the normal way, else every worker is unregistered, every cache
 * dropped and the page reloaded. A null commit on either side (local build)
 * never triggers anything.
 */
export async function checkStaleShell(deps: StaleDeps): Promise<StaleOutcome> {
  const { bundleCommit } = deps;
  if (bundleCommit === null) return 'skipped-null-commit';
  const served = await fetchServedCommit(deps.fetchImpl ?? fetch);
  if (served === undefined) return 'skipped-unreadable';
  if (served === null) return 'skipped-null-commit';
  if (served === bundleCommit) return 'fresh';

  const blocked = (): boolean => {
    const b = deps.getBlockers?.();
    if (b && hasBlockers(b)) {
      deps.onBlocked?.(b);
      return true;
    }
    return false;
  };

  // Something to lose: never repair silently; the confirmed-update banner takes over.
  if (blocked()) return 'needs-confirmation';

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
  }
  // The user may have typed a draft or sent a message during the wait.
  if (blocked()) return 'needs-confirmation';
  // A downloaded new version is activated the normal way, keeping the rollback cache.
  if (deps.activateWaiting?.()) return 'activated-waiting';

  await repairShell(deps, regs);
  return 'repaired';
}

/** The hard repair: unregister every worker, drop every cache, reload. Callers check blockers first. */
export async function repairShell(
  deps: Pick<StaleDeps, 'serviceWorker' | 'cacheStorage' | 'reload'>,
  known?: readonly ServiceWorkerRegistration[],
): Promise<void> {
  const regs = known ?? (await deps.serviceWorker?.getRegistrations()) ?? [];
  await Promise.allSettled(regs.map((r) => r.unregister()));
  if (deps.cacheStorage) {
    const names = await deps.cacheStorage.keys();
    await Promise.allSettled(names.map((n) => deps.cacheStorage!.delete(n)));
  }
  deps.reload();
}

/** Browser wiring for `checkStaleShell`. */
export function runStaleShellCheck(
  bundleCommit: string | null,
  hooks: Pick<StaleDeps, 'getBlockers' | 'onBlocked' | 'activateWaiting'> = {},
): Promise<StaleOutcome> {
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
    ...hooks,
  });
}
