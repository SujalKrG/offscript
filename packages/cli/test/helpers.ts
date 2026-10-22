import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildFixture, claudeCalls, fakeClaude } from "../../core/test/fixture.ts";
import type { Io } from "../src/main.ts";

const KEYS = ["CLAUDE_CONFIG_DIR", "OFFSCRIPT_CLAUDE_BIN", "OFFSCRIPT_CACHE_DIR", "OFFSCRIPT_INNER", "NO_COLOR"] as const;

/** A throwaway repo with one Claude Code session, a fake `claude`, and an isolated cache. Sets process.env until restore(). */
export function setup(opts: { fail?: boolean; claude?: boolean } = {}) {
  const fx = buildFixture();
  const dir = mkdtempSync(join(tmpdir(), "offscript-cli-"));
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.CLAUDE_CONFIG_DIR = dirname(fx.projects);
  process.env.OFFSCRIPT_CACHE_DIR = join(dir, "cache");
  delete process.env.OFFSCRIPT_INNER;
  delete process.env.NO_COLOR;
  if (opts.claude === false) process.env.OFFSCRIPT_CLAUDE_BIN = join(dir, "no-such-claude");
  else process.env.OFFSCRIPT_CLAUDE_BIN = fakeClaude(dir, { fail: opts.fail });
  return {
    fx,
    dir,
    calls: () => claudeCalls(dir),
    cacheFiles: () => {
      try {
        return readdirSync(join(dir, "cache"));
      } catch {
        return [];
      }
    },
    restore() {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    },
  };
}

export function makeIo(cwd: string, extra: { env?: Record<string, string>; stdin?: string; tty?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    readStdin: async () => extra.stdin ?? "",
    env: { ...process.env, ...extra.env },
    cwd,
    outIsTTY: extra.tty ?? false,
    errIsTTY: false,
  };
  return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

/** Dates in the fixture depend on the clock: blank them so output can be compared. */
export const normalize = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?/g, (m) => (m.length > 10 ? "DATE TIME" : "DATE"));

export const emptyDir = (name: string) => {
  const d = join(mkdtempSync(join(tmpdir(), "offscript-empty-")), name);
  mkdirSync(d, { recursive: true });
  return d;
};
