import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { build } from 'vite';

/** Android Chrome profile used by the simulation suite (Pixel 7 emulation: Android UA, mobile viewport, touch). */
export const SIM_LABEL = 'SIMULATED — not Android hardware verified';

let cached: string | null = null;

/** Bundles the fake navigator.bluetooth + MockCompanion into one classic script. */
export async function fakeBluetoothScript(): Promise<string> {
  if (cached) return cached;
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: resolve(process.cwd(), 'src/ble/fakeBluetoothEntry.ts'), formats: ['iife'], name: 'BleSim' },
    },
  });
  const outputs = Array.isArray(out) ? out : [out];
  const first = outputs[0] as { output: Array<{ type: string; code?: string }> };
  const chunk = first.output.find((o) => o.type === 'chunk');
  if (!chunk?.code) throw new Error('failed to bundle the fake Bluetooth');
  cached = chunk.code;
  return cached;
}

export interface SimHandle {
  sendWrites(): Promise<number>;
  rfCount(): Promise<number>;
  totalWrites(): Promise<number>;
}

export async function installSim(page: Page, opts: { sim?: object; dev?: object } = {}): Promise<SimHandle> {
  await page.addInitScript((o) => {
    const w = window as unknown as Record<string, unknown>;
    w.__BLE_SIM_OPTS = o.sim;
    w.__BLE_DEV_OPTS = o.dev;
  }, { sim: opts.sim ?? {}, dev: { responseTimeoutMs: 400, connectTimeoutMs: 400, ...(opts.dev ?? {}) } });
  await page.addInitScript({ content: await fakeBluetoothScript() });
  type W = { __ble: { mock: { sendWrites(): unknown[]; rf: unknown[]; writes: unknown[] } } };
  return {
    sendWrites: () => page.evaluate(() => (window as unknown as W).__ble.mock.sendWrites().length),
    rfCount: () => page.evaluate(() => (window as unknown as W).__ble.mock.rf.length),
    totalWrites: () => page.evaluate(() => (window as unknown as W).__ble.mock.writes.length),
  };
}
