import { execFileSync } from 'node:child_process';

describe('generated API types', () => {
  it('schema.gen.ts is up to date with the OpenAPI contract', () => {
    const root = process.cwd(); // vitest runs from reader/
    // Throws (non-zero exit) when the committed file differs from a fresh generation.
    execFileSync(process.execPath, ['scripts/gen-api.mjs', '--check'], { cwd: root, stdio: 'pipe' });
  });
});
