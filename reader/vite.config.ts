/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const commit = process.env.RENDER_GIT_COMMIT?.trim();

// Keep in sync with deploy/reader-headers.caddy. Applied to `vite preview` so the
// e2e run exercises the built app under the production CSP.
const CSP =
  "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(commit ? commit : null),
  },
  preview: { headers: { 'Content-Security-Policy': CSP } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
