/*
 * MECON Reader kill-switch service worker. A host operator serves this file as
 * /sw.js when rolling back below the first service-worker release, which has
 * no /sw.js of its own (docs/DEVELOPMENT.md, "Rolling back below the first
 * service-worker release"). A browser that installed a Reader worker finds it
 * on its next update check, and this version replaces the old worker, deletes
 * every cache and unregisters itself.
 *
 * It never navigates or reloads a page: a worker cannot see unsent drafts, so
 * open tabs keep running as they are, and the next navigation (or reload) the
 * user makes comes straight from the network. No message text, draft or other
 * private data passes through here. Same-origin static file, no inline script.
 */
'use strict';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) await caches.delete(name);
      await self.registration.unregister();
    })(),
  );
});

// No fetch handler: every request goes to the network.
