import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { build } from 'vite';

export const USB_SIM_LABEL = 'SIMULATED USB — not hardware verified';

let cached: string | null = null;

/** Bundles the fake navigator.serial + simulated devices into one classic script. */
export async function fakeSerialScript(): Promise<string> {
  if (cached) return cached;
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry: resolve(process.cwd(), 'src/device/sim/fakeSerialEntry.ts'), formats: ['iife'], name: 'SerialSim' } },
  });
  const outputs = Array.isArray(out) ? out : [out];
  const first = outputs[0] as { output: Array<{ type: string; code?: string }> };
  const chunk = first.output.find((o) => o.type === 'chunk');
  if (!chunk?.code) throw new Error('failed to bundle the fake serial');
  cached = chunk.code;
  return cached;
}

export type Device = 'companion' | 'stock-companion' | 'repeater' | 'stock-repeater' | 'room' | 'sensor' | 'silent' | 'misleading-board';

export interface UsbSim {
  /** Frames the host wrote to the port (as hex strings of the raw bytes). */
  hostWriteCount(): Promise<number>;
  sendWrites(): Promise<number>;
  rfCount(): Promise<number>;
  /** Console lines a Repeater peer received. */
  consoleLines(): Promise<string[]>;
  executed(): Promise<string[]>;
  openCalls(): Promise<number>;
}

export async function installUsbSim(page: Page, opts: { device?: Device; options?: Record<string, unknown>; dev?: object } = {}): Promise<UsbSim> {
  await page.addInitScript(
    (o) => {
      const w = window as unknown as Record<string, unknown>;
      w.__SERIAL_SIM = { device: o.device, options: o.options };
      w.__USB_DEV_OPTS = o.dev;
    },
    { device: opts.device ?? 'companion', options: opts.options ?? {}, dev: { detect: { stepTimeoutMs: 400 }, companion: { responseTimeoutMs: 400, connectTimeoutMs: 400 }, ...(opts.dev ?? {}) } },
  );
  await page.addInitScript({ content: await fakeSerialScript() });
  type W = { __serial: { hostWrites: unknown[]; openCalls(): number }; __mock?: { sendWrites(): unknown[]; rf: unknown[] }; __peer: { lines?: string[]; executed?: string[] } };
  return {
    hostWriteCount: () => page.evaluate(() => (window as unknown as W).__serial.hostWrites.length),
    sendWrites: () => page.evaluate(() => (window as unknown as W).__mock?.sendWrites().length ?? 0),
    rfCount: () => page.evaluate(() => (window as unknown as W).__mock?.rf.length ?? 0),
    consoleLines: () => page.evaluate(() => [...((window as unknown as W).__peer.lines ?? [])]),
    executed: () => page.evaluate(() => [...((window as unknown as W).__peer.executed ?? [])]),
    openCalls: () => page.evaluate(() => (window as unknown as W).__serial.openCalls()),
  };
}
