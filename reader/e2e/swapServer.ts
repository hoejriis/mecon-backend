import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const READER = resolve(HERE, '..');

/** The production CSP, read from the file Caddy ships so the test cannot drift from it. */
function productionCsp(): string {
  const caddy = readFileSync(resolve(READER, '../deploy/reader-headers.caddy'), 'utf8');
  const m = /Content-Security-Policy "([^"]+)"/.exec(caddy);
  if (!m) throw new Error('CSP not found in deploy/reader-headers.caddy');
  return m[1]!;
}

/** Builds the Reader into `outDir` with the given commit stamp (production build, real sw.js). */
export function buildReader(outDir: string, commit: string): void {
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: READER,
    env: { ...process.env, RENDER_GIT_COMMIT: commit },
    stdio: 'pipe',
  });
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

export interface SwapServer {
  url: string;
  /** Point the server at another built directory: this is "deploying" a new version. */
  deploy(dir: string): void;
  /** Paths the server was asked for, in order. */
  requests: string[];
  close(): Promise<void>;
}

/**
 * A static server shaped like deploy/Caddyfile: production CSP, no-cache outside
 * /assets/, immutable hashed assets, SPA fallback to index.html. `deploy`
 * swaps the served build while the browser keeps its service worker.
 */
export async function startSwapServer(initialDir: string): Promise<SwapServer> {
  let root = initialDir;
  const csp = productionCsp();
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    requests.push(path);
    if (path.startsWith('/api/')) {
      res.writeHead(502).end('the test backend is mocked in the browser');
      return;
    }
    const rel = normalize(path).replace(/^([/\\])+/, '');
    let file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    deploy: (dir) => void (root = dir),
    requests,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}
