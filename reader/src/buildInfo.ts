/**
 * Full git commit of this build, or null for a local build. Kept as a
 * module-level constant that stale-shell repair compares against, so the
 * bundler keeps the whole value (a display-only `slice` would let it fold
 * the full string away).
 */
export const BUILD_COMMIT: string | null = __BUILD_COMMIT__;
