import { checkStaleShell, REPAIR_KEY, VERSION_URL, type StaleDeps } from './staleShell';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function setup(served: unknown, bundleCommit: string | null, regs = 1) {
  const store = new Map<string, string>();
  const reload = vi.fn();
  const order: string[] = [];
  const registration = {
    update: vi.fn(async () => void order.push('update')),
    unregister: vi.fn(async () => void order.push('unregister')),
  };
  const deleted: string[] = [];
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(served))) as unknown as typeof fetch;
  const wait = vi.fn(async (ms: number) => void order.push(`wait${ms}`));
  const deps: StaleDeps = {
    bundleCommit,
    fetchImpl,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    serviceWorker: {
      getRegistrations: async () =>
        Array.from({ length: regs }, () => registration) as unknown as ServiceWorkerRegistration[],
    },
    cacheStorage: { keys: async () => ['c1', 'c2'], delete: async (n) => (deleted.push(n), true) },
    reload,
    wait,
  };
  return { deps, reload, order, deleted, fetchImpl, store, registration };
}

describe('checkStaleShell', () => {
  it('differing commits: update, wait 3 s, unregister, drop caches, reload', async () => {
    const t = setup({ commit: B }, A);
    expect(await checkStaleShell(t.deps)).toBe('repaired');
    expect(t.fetchImpl).toHaveBeenCalledWith(VERSION_URL, expect.objectContaining({ cache: 'no-store' }));
    expect(t.order).toEqual(['update', 'wait3000', 'unregister']);
    expect(t.deleted).toEqual(['c1', 'c2']);
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(t.store.get(REPAIR_KEY)).toBe(B);
  });

  it('reloads at most once per served commit', async () => {
    const t = setup({ commit: B }, A);
    await checkStaleShell(t.deps);
    expect(await checkStaleShell(t.deps)).toBe('already-attempted');
    expect(t.reload).toHaveBeenCalledTimes(1);
    // a newer served commit is a new attempt
    const t2 = { ...t.deps, fetchImpl: (async () => new Response(JSON.stringify({ commit: 'c'.repeat(40) }))) as unknown as typeof fetch };
    expect(await checkStaleShell(t2)).toBe('repaired');
    expect(t.reload).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the bundle commit is null (local build), without even fetching', async () => {
    const t = setup({ commit: B }, null);
    expect(await checkStaleShell(t.deps)).toBe('skipped-null-commit');
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing when the served commit is null', async () => {
    const t = setup({ commit: null }, A);
    expect(await checkStaleShell(t.deps)).toBe('skipped-null-commit');
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.deleted).toEqual([]);
  });

  it('does nothing when the commits match', async () => {
    const t = setup({ commit: A }, A);
    expect(await checkStaleShell(t.deps)).toBe('fresh');
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('does nothing when /version.json is not JSON (dev server answers HTML)', async () => {
    const t = setup(null, A);
    t.deps.fetchImpl = (async () => new Response('<html>')) as unknown as typeof fetch;
    expect(await checkStaleShell(t.deps)).toBe('skipped-unreadable');
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('with no service worker registered it still drops caches and reloads once, with no wait', async () => {
    const t = setup({ commit: B }, A, 0);
    expect(await checkStaleShell(t.deps)).toBe('repaired');
    expect(t.order).toEqual([]);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });
});

describe('checkStaleShell reconciled with the update guards', () => {
  const blocked = { drafts: 1, uncertainAttempts: 0, bleConnected: false };
  const clear = { drafts: 0, uncertainAttempts: 0, bleConnected: false };

  it('drafts present before the check: no repair, no reload, banner notified, attempt not consumed', async () => {
    const t = setup({ commit: B }, A);
    const onBlocked = vi.fn();
    expect(await checkStaleShell({ ...t.deps, getBlockers: () => blocked, onBlocked })).toBe('needs-confirmation');
    expect(onBlocked).toHaveBeenCalledWith(blocked);
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.registration.unregister).not.toHaveBeenCalled();
    expect(t.deleted).toEqual([]);
    expect(t.store.get(REPAIR_KEY)).toBeUndefined();
  });

  it.each([
    ['uncertain attempts', { ...clear, uncertainAttempts: 2 }],
    ['a BLE connection', { ...clear, bleConnected: true }],
  ])('%s block the repair too', async (_n, b) => {
    const t = setup({ commit: B }, A);
    expect(await checkStaleShell({ ...t.deps, getBlockers: () => b })).toBe('needs-confirmation');
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.deleted).toEqual([]);
  });

  it('a draft typed during the 3 s wait stops the repair before it unregisters or reloads', async () => {
    const t = setup({ commit: B }, A);
    let b = clear;
    const deps = { ...t.deps, getBlockers: () => b, wait: async () => void (b = blocked) };
    expect(await checkStaleShell(deps)).toBe('needs-confirmation');
    expect(t.registration.update).toHaveBeenCalled();
    expect(t.registration.unregister).not.toHaveBeenCalled();
    expect(t.deleted).toEqual([]);
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('nothing to lose: the repair still happens by itself', async () => {
    const t = setup({ commit: B }, A);
    expect(await checkStaleShell({ ...t.deps, getBlockers: () => clear })).toBe('repaired');
    expect(t.reload).toHaveBeenCalledTimes(1);
    expect(t.deleted).toEqual(['c1', 'c2']);
  });

  it('a downloaded waiting version is activated the normal way, keeping the caches', async () => {
    const t = setup({ commit: B }, A);
    const activateWaiting = vi.fn(() => true);
    expect(await checkStaleShell({ ...t.deps, getBlockers: () => clear, activateWaiting })).toBe('activated-waiting');
    expect(t.registration.unregister).not.toHaveBeenCalled();
    expect(t.deleted).toEqual([]);
    expect(t.reload).not.toHaveBeenCalled();
  });
});
