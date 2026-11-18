import { defineConfig, devices } from '@playwright/test';

// Live acceptance project: runs against a deployed Reader, never in normal CI.
// Trace, video and screenshots are off so no session value can reach an artifact.
export default defineConfig({
  testDir: './acceptance',
  outputDir: './e2e-artifacts/acceptance',
  reporter: [['list']],
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: process.env.ACCEPTANCE_BASE_URL ?? 'https://reader.mecon.cloud',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [{ name: 'live', use: { ...devices['Desktop Chrome'] } }],
});
