import { mkdirSync, writeFileSync } from 'node:fs';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

interface Row {
  title: string;
  status: string;
  ms: number;
}

/** Writes e2e-artifacts/ble-simulation-matrix.md from the SIMULATED BLE tests. */
export default class BleMatrixReporter implements Reporter {
  private rows: Row[] = [];
  private usbRows: Row[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!test.title.startsWith('SIMULATED')) return;
    if (test.title.startsWith('SIMULATED USB')) {
      this.usbRows.push({ title: test.title, status: result.status, ms: result.duration });
      return;
    }
    this.rows.push({ title: test.title, status: result.status, ms: result.duration });
  }

  onEnd(): void {
    this.writeUsb();
    if (this.rows.length === 0) return;
    this.rows.sort((a, b) => a.title.localeCompare(b.title));
    const pass = this.rows.filter((r) => r.status === 'passed').length;
    const lines = [
      '# BLE simulation matrix',
      '',
      '**SIMULATED — not Android hardware verified.** Every result below comes from a fake `navigator.bluetooth` backed by a synthetic Companion, running in headless Chromium with an Android (Pixel 7) user agent and mobile viewport. No Bluetooth hardware, no real Companion and no RF were involved. Real Android Chrome Web Bluetooth compatibility is unverified until tested on a device.',
      '',
      `Generated ${new Date().toISOString()}. Passed ${pass} of ${this.rows.length}.`,
      '',
      '| Result | Case | Duration |',
      '|---|---|---|',
      ...this.rows.map((r) => `| ${r.status === 'passed' ? 'PASS (simulated)' : r.status.toUpperCase() + ' (simulated)'} | ${r.title} | ${r.ms} ms |`),
      '',
    ];
    mkdirSync('e2e-artifacts', { recursive: true });
    writeFileSync('e2e-artifacts/ble-simulation-matrix.md', lines.join('\n'));
  }

  private writeUsb(): void {
    if (this.usbRows.length === 0) return;
    this.usbRows.sort((a, b) => a.title.localeCompare(b.title));
    const pass = this.usbRows.filter((r) => r.status === 'passed').length;
    const lines = [
      '# USB simulation matrix',
      '',
      '**SIMULATED - not hardware verified.** Every result below comes from a fake `navigator.serial` backed by a synthetic device (Companion or Repeater), running in headless desktop Chromium. No USB hardware, no real firmware and no RF were involved. Real Web Serial and firmware behaviour is unverified until tested on a laptop with a device.',
      '',
      `Generated ${new Date().toISOString()}. Passed ${pass} of ${this.usbRows.length}.`,
      '',
      '| Result | Case | Duration |',
      '|---|---|---|',
      ...this.usbRows.map((r) => `| ${r.status === 'passed' ? 'PASS (simulated)' : r.status.toUpperCase() + ' (simulated)'} | ${r.title} | ${r.ms} ms |`),
      '',
    ];
    mkdirSync('e2e-artifacts', { recursive: true });
    writeFileSync('e2e-artifacts/usb-simulation-matrix.md', lines.join('\n'));
  }
}
