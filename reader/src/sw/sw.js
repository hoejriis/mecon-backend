/*
 * MECON Reader service worker (same-origin static file, no inline script).
 * The build plugin (src/sw/buildSw.ts) replaces the BUILD placeholder below
 * with this build's version and precache list and writes the result to /sw.js.
 *
 * Lifecycle rules (docs/DEVELOPMENT.md, "Safe updates"):
 *  - install downloads the whole build into a cache named by the build version
 *    and NEVER calls skipWaiting; activation happens only on a SKIP_WAITING
 *    message the page sends after the user confirmed.
 *  - a failed or interrupted install deletes only its own incomplete cache and
 *    leaves the running version and its cache untouched.
 *  - the previous version's cache is kept after activation until the new
 *    version's page reports it booted (BOOT_OK) and no other tab is open (an
 *    old tab may still need the previous version's files); only then is it deleted.
 *    Caches older than the previous one are deleted on activation.
 *  - /api/ is never answered by the worker: the browser goes to the network.
 *  - no message text, draft or other private data passes through here.
 */
'use strict';

const BUILD = /*__SW_BUILD__*/ null;

const PREFIX = 'mecon-reader-shell-';
const META_CACHE = 'mecon-reader-meta';
const META_URL = '/__sw-meta';
const DONE_URL = '/__sw-complete';
const SHELL = '/index.html';
const CACHE = PREFIX + BUILD.version;
const ASSET_SET = new Set(BUILD.assets);

async function readMeta() {
  const empty = { current: null, previous: null, bootOk: false };
  try {
    const c = await caches.open(META_CACHE);
    const r = await c.match(META_URL);
    if (!r) return empty;
    const m = await r.json();
    return { current: m.current ?? null, previous: m.previous ?? null, bootOk: m.bootOk === true };
  } catch {
    return empty;
  }
}

async function writeMeta(meta) {
  const c = await caches.open(META_CACHE);
  await c.put(
    META_URL,
    new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }),
  );
}

async function precache() {
  if (await caches.has(CACHE)) {
    const existing = await caches.open(CACHE);
    if (await existing.match(DONE_URL)) return; // already complete
    await caches.delete(CACHE); // a leftover partial download
  }
  const cache = await caches.open(CACHE);
  try {
    await Promise.all(
      BUILD.assets.map(async (url) => {
        const res = await fetch(url, { cache: 'reload' });
        if (!res.ok) throw new Error('precache ' + url + ' -> ' + res.status);
        await cache.put(url, res);
      }),
    );
    await cache.put(DONE_URL, new Response('ok'));
  } catch (err) {
    // Interrupted or failed: drop only the incomplete cache of THIS version.
    await caches.delete(CACHE);
    throw err;
  }
}

async function activate() {
  const meta = await readMeta();
  let next = meta;
  if (meta.current !== CACHE) {
    next = { current: CACHE, previous: meta.current, bootOk: false };
    await writeMeta(next);
  }
  // Only now, after the new state is recorded, drop caches older than the previous one.
  const keep = new Set([next.current, next.previous]);
  for (const name of await caches.keys()) {
    if (name.startsWith(PREFIX) && !keep.has(name)) await caches.delete(name);
  }
  await self.clients.claim();
}

async function bootOk(commit) {
  if (commit !== BUILD.commit) return; // an old page of another version must not vouch for this one
  const meta = await readMeta();
  if (meta.current !== CACHE || meta.bootOk) return;
  // Another open tab may still run the previous version and need its lazy chunks:
  // keep the rollback cache until the reporting page is the only one left.
  const open = await self.clients.matchAll({ type: 'window' });
  if (open.length > 1) return;
  const prev = meta.previous;
  await writeMeta({ current: CACHE, previous: null, bootOk: true });
  if (prev && prev !== CACHE) await caches.delete(prev);
}

async function fromShellCaches(key) {
  if (await caches.has(CACHE)) {
    const hit = await (await caches.open(CACHE)).match(key);
    if (hit) return hit;
  }
  const meta = await readMeta();
  if (meta.previous && meta.previous !== CACHE && (await caches.has(meta.previous))) {
    const hit = await (await caches.open(meta.previous)).match(key);
    if (hit) return hit;
  }
  return undefined;
}

self.addEventListener('install', (event) => {
  // No skipWaiting here: a new version waits for the user.
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(activate());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  } else if (data.type === 'BOOT_OK') {
    event.waitUntil(bootOk(data.commit ?? null));
  } else if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: BUILD.version, commit: BUILD.commit });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // The API is network only: never cached, no offline fallback.
  if (url.pathname.startsWith('/api/')) return;

  if (ASSET_SET.has(url.pathname) && url.pathname !== SHELL) {
    event.respondWith(
      fromShellCaches(url.pathname).then((hit) => hit ?? fetch(req)),
    );
    return;
  }
  if (req.mode === 'navigate' && !url.pathname.endsWith('.json')) {
    event.respondWith(fromShellCaches(SHELL).then((hit) => hit ?? fetch(req)));
  }
  // Anything else (version.json, sw.js, unknown paths) goes to the network.
});
