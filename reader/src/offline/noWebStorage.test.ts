// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('offline modules', () => {
  it('never touch localStorage or sessionStorage (private data lives only in the encrypted IndexedDB store)', () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});
