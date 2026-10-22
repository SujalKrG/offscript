// Content-addressed disk cache for model results. One JSON file per key, written atomically
// (tmp file, then rename), so a crash or a parallel run never leaves a half-written entry.
// The cache is best effort: any failure means "miss", never an error.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where cached results live. OFFSCRIPT_CACHE_DIR wins (tests); then XDG; then LOCALAPPDATA on Windows; then ~/.cache. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, home: string = homedir()): string {
  if (env.OFFSCRIPT_CACHE_DIR) return env.OFFSCRIPT_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "offscript");
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "offscript");
  return join(home, ".cache", "offscript");
}

/** sha256 over the parts, with a separator that cannot appear inside a part boundary ambiguously. */
export function cacheKey(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(String(p.length));
    h.update(":");
    h.update(p);
  }
  return h.digest("hex");
}

const KEY_RE = /^[a-f0-9]{16,128}$/;

export function getCached(key: string): unknown | null {
  if (!KEY_RE.test(key)) return null;
  try {
    return JSON.parse(readFileSync(join(cacheDir(), `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function putCached(key: string, value: unknown): boolean {
  if (!KEY_RE.test(key)) return false;
  const dir = cacheDir();
  const tmp = join(dir, `${key}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(value), "utf8");
    renameSync(tmp, join(dir, `${key}.json`));
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing left to clean
    }
    return false;
  }
}
