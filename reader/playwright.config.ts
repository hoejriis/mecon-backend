import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e-artifacts/results',
  reporter: [['list'], ['./e2e/bleMatrixReporter.ts']],
  use: { baseURL: 'http://127.0.0.1:4173' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /(ble|usb|ble-device)\.spec\.ts/ },
    // Android-oriented BLE simulation: Android Chrome user agent, mobile viewport, fake Web Bluetooth.
    // Runs against the dev server because the BLE harness route exists only in dev builds.
    {
      name: 'android-ble-sim',
      use: { ...devices['Pixel 7'], baseURL: 'http://127.0.0.1:4174' },
      testMatch: /ble(-device)?\.spec\.ts/,
    },
    // Laptop-Chromium USB simulation: desktop UA, fake Web Serial. Runs against the dev server (the harness route exists only in dev builds).
    {
      name: 'usb-sim',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4174' },
      testMatch: /usb\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'npm run build && npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Bounded dev server (10 minutes) for the BLE harness route.
      command: "perl -e 'alarm shift; exec @ARGV' 600 npx vite --host 127.0.0.1 --port 4174 --strictPort",
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
