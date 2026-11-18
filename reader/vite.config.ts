/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const commit = process.env.RENDER_GIT_COMMIT?.trim();

// Publishes the served build's commit at /version.json (the Reader compares it
// with the commit compiled into the bundle to detect a stale installed shell).
// The Backend's /health reports the Backend's commit, so it cannot be used for this.
function versionJson(): Plugin {
  const body = JSON.stringify({ commit: commit ? commit : null });
  return {
    name: 'mecon-version-json',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: body });
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
      });
    },
  };
}

// Keep in sync with deploy/reader-headers.caddy. Applied to `vite preview` so the
// e2e run exercises the built app under the production CSP.
const CSP =
  "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export default defineConfig({
  plugins: [react(), versionJson()],
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
