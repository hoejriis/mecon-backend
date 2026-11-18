import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listAssets, makeBuild, renderSw } from './buildSw';

const TEMPLATE = readFileSync(resolve(import.meta.dirname, 'sw.js'), 'utf8');
const ORIGIN = 'https://reader.test';
const ASSETS = ['/index.html', '/assets/app-1.js', '/assets/app-1.css', '/brand/logo.svg'];

type Listener = (e: Record<string, unknown>) => void;

class FakeCache {
  entries = new Map<string, Response>();
  private key = (r: string | { url: string }) => (typeof r === 'string' ? r : new URL(r.url).pathname);
  async put(r: string | { url: string }, res: Response) {
    this.entries.set(this.key(r), res.clone());
  }
  async match(r: string | { url: string }) {
    return this.entries.get(this.key(r))?.clone();
  }
}

class FakeCaches {
  store = new Map<string, FakeCache>();
  async open(n: string) {
    if (!this.store.has(n)) this.store.set(n, new FakeCache());
    return this.store.get(n)!;
  }
  async has(n: string) {
    return this.store.has(n);
  }
  async delete(n: string) {
    return this.store.delete(n);
  }
  async keys() {
    return [...this.store.keys()];
  }
  names() {
    return [...this.store.keys()].sort();
  }
}

/** Loads the real sw.js source for one build into a fake worker global. */
function loadWorker(commit: string | null, shared?: FakeCaches, assets = ASSETS) {
  const caches = shared ?? new FakeCaches();
  const build = makeBuild(commit, assets);
  const listeners = new Map<string, Listener>();
  const skipWaiting = vi.fn(async () => undefined);
  const claim = vi.fn(async () => undefined);
  const openTabs = { count: 1 };
  const net = {
    online: true,
    failOn: new Set<string>(),
    log: [] as string[],
  };
  const fetchImpl = vi.fn(async (input: string | { url: string }) => {
    const path = typeof input === 'string' ? input : new URL(input.url).pathname;
    net.log.push(path);
    if (!net.online) throw new TypeError('offline');
    if (net.failOn.has(path)) return new Response('nope', { status: 500 });
    return new Response(`network:${path}@${build.version}`);
  });
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, cb: Listener) => void listeners.set(t, cb),
    skipWaiting,
    clients: { claim, matchAll: async () => Array.from({ length: openTabs.count }, () => ({})) },
  };
  new Function('self', 'caches', 'fetch', renderSw(TEMPLATE, build))(self, caches, fetchImpl);

  const lifecycle = async (type: 'install' | 'activate') => {
    let p: Promise<unknown> = Promise.resolve();
    listeners.get(type)!({ waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  const message = async (data: unknown) => {
    let p: Promise<unknown> = Promise.resolve();
    listeners.get('message')!({ data, source: null, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  const fetchEvent = async (path: string, init: { method?: string; mode?: string; origin?: string } = {}) => {
    let responded: Promise<Response> | null = null;
    listeners.get('fetch')!({
      request: { method: init.method ?? 'GET', url: (init.origin ?? ORIGIN) + path, mode: init.mode ?? 'no-cors' },
      respondWith: (p: Promise<Response>) => (responded = p),
    });
    return responded ? ((await responded) as Response) : null; // null: left to the network
  };
  return { caches, build, skipWaiting, claim, openTabs, net, fetchImpl, lifecycle, message, fetchEvent };
}

const cacheName = (v: string) => `mecon-reader-shell-${v}`;
const V1 = 'a'.repeat(40);
const V2 = 'b'.repeat(40);
const V3 = 'c'.repeat(40);

async function install(commit: string, shared?: FakeCaches) {
  const w = loadWorker(commit, shared);
  await w.lifecycle('install');
  return w;
}
async function installAndActivate(commit: string, shared?: FakeCaches) {
  const w = await install(commit, shared);
  await w.lifecycle('activate');
  return w;
}

describe('build helpers', () => {
  it('local builds get a content-derived version, commits are used verbatim', () => {
    expect(makeBuild(V1, ASSETS).version).toBe(V1);
    const a = makeBuild(null, ASSETS).version;
    expect(a).toMatch(/^local-[0-9a-f]{12}$/);
    expect(makeBuild(null, [...ASSETS, '/assets/other.js']).version).not.toBe(a);
  });
  it('refuses a template that lost its placeholder', () => {
    expect(() => renderSw('const BUILD = null;', makeBuild(null, []))).toThrow(/placeholder/);
  });
  it('listAssets leaves out the worker, version.json and source maps', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(resolve(tmpdir(), 'sw-assets-'));
    mkdirSync(resolve(dir, 'assets'));
    for (const f of ['index.html', 'sw.js', 'version.json', 'assets/a.js', 'assets/a.js.map']) writeFileSync(resolve(dir, f), 'x');
    expect(listAssets(dir)).toEqual(['/assets/a.js', '/index.html']);
  });
});

describe('install', () => {
  it('downloads every asset into a cache named by the version and does NOT skip waiting', async () => {
    const w = await install(V1);
    const c = w.caches.store.get(cacheName(V1))!;
    expect([...c.entries.keys()].filter((k) => !k.startsWith('/__')).sort()).toEqual([...ASSETS].sort());
    expect(w.skipWaiting).not.toHaveBeenCalled();
    expect(w.claim).not.toHaveBeenCalled();
  });

  it('keeps the previous version cache and its metadata untouched while installing', async () => {
    const caches = new FakeCaches();
    await installAndActivate(V1, caches);
    const before = [...caches.store.get(cacheName(V1))!.entries.keys()].sort();
    const w2 = await install(V2, caches);
    expect(caches.names()).toEqual(['mecon-reader-meta', cacheName(V1), cacheName(V2)].sort());
    expect([...caches.store.get(cacheName(V1))!.entries.keys()].sort()).toEqual(before);
    expect(w2.skipWaiting).not.toHaveBeenCalled();
    // still recorded as V1 until V2 activates
    const meta = await (await caches.store.get('mecon-reader-meta')!.match('/__sw-meta'))!.json();
    expect(meta.current).toBe(cacheName(V1));
  });

  it('a failed download rejects the install, removes only the incomplete cache and leaves the running version alone', async () => {
    const caches = new FakeCaches();
    const running = await installAndActivate(V1, caches);
    const w2 = loadWorker(V2, caches);
    w2.net.failOn.add('/assets/app-1.js');
    await expect(w2.lifecycle('install')).rejects.toThrow(/precache/);
    expect(caches.names()).toEqual(['mecon-reader-meta', cacheName(V1)].sort());
    expect(w2.skipWaiting).not.toHaveBeenCalled();
    // the running version still serves
    const res = await running.fetchEvent('/probe/ble', { mode: 'navigate' });
    expect(await res!.text()).toContain(`network:/index.html@${V1}`);
  });

  it('an interrupted download (network drops) behaves the same', async () => {
    const caches = new FakeCaches();
    await installAndActivate(V1, caches);
    const w2 = loadWorker(V2, caches);
    w2.net.online = false;
    await expect(w2.lifecycle('install')).rejects.toThrow();
    expect(caches.names()).toEqual(['mecon-reader-meta', cacheName(V1)].sort());
  });

  it('a retry after an interrupted install starts clean, not from a partial cache', async () => {
    const caches = new FakeCaches();
    // simulate a partial cache left by a killed worker (no completion marker)
    await (await caches.open(cacheName(V2))).put('/index.html', new Response('half'));
    const w = loadWorker(V2, caches);
    await w.lifecycle('install');
    const c = caches.store.get(cacheName(V2))!;
    expect(await (await c.match('/index.html'))!.text()).toBe(`network:/index.html@${V2}`);
    expect(c.entries.has('/__sw-complete')).toBe(true);
  });
});

describe('activation, rollback window and cleanup', () => {
  it('activation keeps the previous cache, deletes older ones, and claims clients', async () => {
    const caches = new FakeCaches();
    await installAndActivate(V1, caches);
    await installAndActivate(V2, caches);
    expect(caches.names()).toEqual(['mecon-reader-meta', cacheName(V1), cacheName(V2)].sort());
    const w3 = await installAndActivate(V3, caches);
    expect(caches.names()).toEqual(['mecon-reader-meta', cacheName(V2), cacheName(V3)].sort()); // V1 is older than the previous
    expect(w3.claim).toHaveBeenCalled();
  });

  it('the previous cache goes only after the new version reports it booted', async () => {
    const caches = new FakeCaches();
    await installAndActivate(V1, caches);
    const w2 = await installAndActivate(V2, caches);
    expect(caches.names()).toContain(cacheName(V1));
    await w2.message({ type: 'BOOT_OK', commit: V1 }); // an old page cannot vouch for the new version
    expect(caches.names()).toContain(cacheName(V1));
    await w2.message({ type: 'BOOT_OK', commit: V2 });
    expect(caches.names()).toEqual(['mecon-reader-meta', cacheName(V2)].sort());
  });

  it('the previous cache stays while another tab is open (it may still run that version)', async () => {
    const caches = new FakeCaches();
    await installAndActivate(V1, caches);
    const w2 = await installAndActivate(V2, caches);
    w2.openTabs.count = 2;
    await w2.message({ type: 'BOOT_OK', commit: V2 });
    expect(caches.names()).toContain(cacheName(V1));
    w2.openTabs.count = 1; // the old tab reloaded; the new page reports again
    await w2.message({ type: 'BOOT_OK', commit: V2 });
    expect(caches.names()).not.toContain(cacheName(V1));
  });

  it('rollback window: an asset missing from the new cache is still served from the previous one', async () => {
    const caches = new FakeCaches();
    await installAndActivate(V1, caches);
    const w2 = await installAndActivate(V2, caches);
    await caches.store.get(cacheName(V2))!.entries.delete('/assets/app-1.js');
    w2.net.online = false;
    const res = await w2.fetchEvent('/assets/app-1.js');
    expect(await res!.text()).toBe(`network:/assets/app-1.js@${V1}`);
  });

  it('only a SKIP_WAITING message activates a waiting worker', async () => {
    const w = await install(V1);
    await w.message({ type: 'SOMETHING_ELSE' });
    await w.message('SKIP_WAITING');
    expect(w.skipWaiting).not.toHaveBeenCalled();
    await w.message({ type: 'SKIP_WAITING' });
    expect(w.skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe('fetch handling', () => {
  it('serves the app shell for navigations while offline', async () => {
    const w = await installAndActivate(V1);
    w.net.online = false;
    for (const path of ['/', '/chats', '/probe/ble', '/settings']) {
      const res = await w.fetchEvent(path, { mode: 'navigate' });
      expect(await res!.text()).toBe(`network:/index.html@${V1}`);
    }
    const asset = await w.fetchEvent('/assets/app-1.js');
    expect(await asset!.text()).toBe(`network:/assets/app-1.js@${V1}`);
  });

  it('never handles /api/: no response from the worker, nothing stored, even navigations', async () => {
    const w = await installAndActivate(V1);
    const before = JSON.stringify([...w.caches.store].map(([n, c]) => [n, [...c.entries.keys()]]));
    for (const p of ['/api/reader/v1/session', '/api/reader/v1/conversations?limit=50', '/api/anything']) {
      expect(await w.fetchEvent(p)).toBeNull();
      expect(await w.fetchEvent(p, { mode: 'navigate' })).toBeNull();
    }
    expect(w.fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/api/'))).toEqual([]);
    expect(JSON.stringify([...w.caches.store].map(([n, c]) => [n, [...c.entries.keys()]]))).toBe(before);
    expect([...w.caches.store.values()].flatMap((c) => [...c.entries.keys()]).filter((k) => k.includes('/api'))).toEqual([]);
  });

  it('leaves non-GET, cross-origin, version.json and sw.js to the network', async () => {
    const w = await installAndActivate(V1);
    expect(await w.fetchEvent('/assets/app-1.js', { method: 'POST' })).toBeNull();
    expect(await w.fetchEvent('/assets/app-1.js', { origin: 'https://elsewhere.test' })).toBeNull();
    expect(await w.fetchEvent('/version.json')).toBeNull();
    expect(await w.fetchEvent('/version.json', { mode: 'navigate' })).toBeNull();
    expect(await w.fetchEvent('/sw.js')).toBeNull();
    expect(await w.fetchEvent('/not-in-the-build.png')).toBeNull();
  });
});
