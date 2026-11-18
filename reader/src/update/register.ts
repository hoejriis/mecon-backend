import { repairShell } from '../staleShell';
import { collectBlockers } from './guards';
import { CHANNEL_NAME, UpdateController } from './updateController';

export const SW_URL = '/sw.js';
const UPDATE_CHECK_MS = 60 * 60 * 1000;

function openChannel(): BroadcastChannel | null {
  try {
    return 'BroadcastChannel' in globalThis ? new BroadcastChannel(CHANNEL_NAME) : null;
  } catch {
    return null;
  }
}

let started: UpdateController | null | undefined;

/** The tab's controller, or null where service workers are unavailable (dev, old browsers). */
export function getUpdateController(): UpdateController | null {
  return started ?? null;
}

/**
 * Registers the worker (production builds only) and returns the controller
 * that drives the update banner. Idempotent.
 */
export async function startUpdates(commit: string | null): Promise<UpdateController | null> {
  if (started !== undefined) return started;
  started = null;
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return null;
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' });
  } catch {
    return null; // the Reader works without a worker
  }
  const channel = openChannel();
  const container = navigator.serviceWorker;
  const controller = new UpdateController({
    container,
    registration,
    channel,
    getBlockers: collectBlockers,
    reload: () => window.location.reload(),
    hardRepair: () =>
      repairShell({
        serviceWorker: container,
        cacheStorage: 'caches' in window ? window.caches : null,
        reload: () => window.location.reload(),
      }),
  });
  controller.start();
  started = controller;

  // Tell the worker this version's page booted (releases the rollback cache).
  const bootOk = () => container.controller?.postMessage({ type: 'BOOT_OK', commit });
  if (container.controller) bootOk();
  else container.addEventListener('controllerchange', bootOk, { once: true });

  const recheck = () => {
    if (document.visibilityState === 'visible') void registration.update().catch(() => undefined);
  };
  document.addEventListener('visibilitychange', recheck);
  window.setInterval(recheck, UPDATE_CHECK_MS);
  return controller;
}
