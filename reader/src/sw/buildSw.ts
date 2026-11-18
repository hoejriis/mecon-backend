import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface SwBuild {
  /** Cache-name suffix: the full commit, or `local-<hash>` when no commit is set. */
  version: string;
  commit: string | null;
  /** Absolute URL paths to precache. */
  assets: string[];
}

const PLACEHOLDER = '/*__SW_BUILD__*/ null';
/** Files that must always come from the network. */
const NEVER_PRECACHE = new Set(['/sw.js', '/version.json']);

export function listAssets(distDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push('/' + relative(distDir, p).split(sep).join('/'));
    }
  };
  walk(distDir);
  return out.filter((u) => !NEVER_PRECACHE.has(u) && !u.endsWith('.map')).sort();
}

export function makeBuild(commit: string | null, assets: string[]): SwBuild {
  const hash = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12);
  return { version: commit ?? `local-${hash}`, commit, assets };
}

export function renderSw(template: string, build: SwBuild): string {
  if (!template.includes(PLACEHOLDER)) throw new Error('sw template lost its build placeholder');
  return template.replace(PLACEHOLDER, JSON.stringify(build));
}

/** Writes `<dist>/sw.js` for the files already in `dist`. */
export function writeSw(distDir: string, templatePath: string, commit: string | null): SwBuild {
  const build = makeBuild(commit, listAssets(distDir));
  writeFileSync(join(distDir, 'sw.js'), renderSw(readFileSync(templatePath, 'utf8'), build));
  return build;
}
