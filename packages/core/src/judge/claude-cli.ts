// Model backend: the user's own Claude Code CLI in headless mode. No API key needed;
// it uses whatever login Claude Code already has (subscription or key).
//
// Safety rails:
// - runs from an empty temp dir, so no repo CLAUDE.md, MCP config or settings load
// - --safe-mode skips hooks/plugins/CLAUDE.md (prevents our own Stop hook firing inside the call)
// - OFFSCRIPT_INNER=1 is a second loop guard for offscript's own hooks
// - all tools disabled, one turn, no session file written

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../redact.ts";

export interface JudgeResult<T> {
  ok: boolean;
  value: T | null;
  costUsd: number | null;
  error: string | null;
  attempt: string;
}

export interface Candidate {
  cmd: string;
  shell: boolean;
}

function candidates(): Candidate[] {
  const custom = process.env.OFFSCRIPT_CLAUDE_BIN;
  if (custom) return [{ cmd: custom, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(custom) }];
  if (process.platform === "win32") {
    return [
      { cmd: "claude.exe", shell: false },
      { cmd: "claude", shell: false },
      { cmd: "claude.cmd", shell: true },
    ];
  }
  return [{ cmd: "claude", shell: false }];
}

function quoteForCmd(a: string): string {
  return `"${a.replace(/"/g, '\\"')}"`;
}

/** The program to spawn. Through cmd.exe it must be quoted too, or a path with a space ("C:\\Users\\Jo Smith\\...\\claude.cmd") splits. */
export function spawnTarget(c: Candidate): string {
  return c.shell ? quoteForCmd(c.cmd) : c.cmd;
}

/** Whatever the CLI printed can echo the prompt, so errors that reach the terminal, JSON or a report are redacted first. */
const safe = (s: string) => redact(s).text;

export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(stripped.slice(start, end + 1));
}

/** Best effort: on Windows a just-killed child can hold the directory for a moment. A cleanup failure must never fail a review. */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // leave it for the OS temp cleaner
  }
}

/** spawnSync's timeout kills only the direct child. On Windows that is cmd.exe, and the real claude process would live on holding the temp dir. */
function killTree(pid: number | undefined): void {
  if (process.platform !== "win32" || !pid) return;
  try {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
  } catch {
    // already gone
  }
}

export function claudeAvailable(): boolean {
  for (const c of candidates()) {
    const r = spawnSync(spawnTarget(c), ["--version"], { encoding: "utf8", shell: c.shell, windowsHide: true, timeout: 20000 });
    if (r.status === 0) return true;
  }
  return false;
}

export function judgeModel(): string {
  return process.env.OFFSCRIPT_MODEL ?? "haiku";
}

export function runClaudeJson<T>(opts: { system: string; input: string; model?: string; timeoutMs?: number; validate?: (v: unknown) => T }): JudgeResult<T> {
  const model = opts.model ?? judgeModel();
  const dir = mkdtempSync(join(tmpdir(), "offscript-judge-"));
  const sysPath = join(dir, "system.txt");
  writeFileSync(sysPath, opts.system, "utf8");

  const common = ["-p", "--model", model, "--output-format", "json", "--system-prompt-file", sysPath];
  const attempts: { name: string; args: string[] }[] = [
    {
      name: "safe-mode",
      args: [...common, "--safe-mode", "--disallowedTools", "*", "--no-session-persistence", "--max-turns", "1"],
    },
    { name: "no-safe-mode", args: [...common, "--disallowedTools", "*", "--no-session-persistence", "--max-turns", "1"] },
    { name: "minimal", args: common },
  ];

  let lastError = "claude CLI not found on PATH (set OFFSCRIPT_CLAUDE_BIN to its full path)";
  try {
    for (const c of candidates()) {
      for (const a of attempts) {
        const args = c.shell ? a.args.map(quoteForCmd) : a.args;
        const r = spawnSync(spawnTarget(c), args, {
          input: opts.input,
          cwd: dir,
          encoding: "utf8",
          shell: c.shell,
          windowsHide: true,
          timeout: opts.timeoutMs ?? 240_000,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, OFFSCRIPT_INNER: "1" },
        });
        if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") break; // try next binary
        // A timeout is not an old-CLI problem: retrying with fewer flags would only wait the full timeout again, twice more.
        if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          killTree(r.pid);
          return {
            ok: false,
            value: null,
            costUsd: null,
            error: `${a.name}: claude CLI timed out after ${Math.round((opts.timeoutMs ?? 240_000) / 1000)}s`,
            attempt: a.name,
          };
        }
        const stdout = (r.stdout ?? "").trim();
        const stderr = (r.stderr ?? "").trim();
        if (r.status !== 0 && /unknown option|unrecognized|unexpected argument|error: option/i.test(stderr + stdout)) {
          lastError = `${a.name}: ${safe((stderr || stdout).slice(0, 300))}`;
          continue; // older CLI: retry with fewer flags
        }
        let envelope: any;
        try {
          envelope = JSON.parse(stdout);
        } catch {
          lastError = `${a.name}: CLI did not return JSON (exit ${r.status}): ${safe((stderr || stdout).slice(0, 300))}`;
          continue;
        }
        const cost = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null;
        if (envelope.is_error) {
          return { ok: false, value: null, costUsd: cost, error: safe(String(envelope.result ?? "model error").slice(0, 500)), attempt: a.name };
        }
        try {
          const parsed = extractJson(String(envelope.result ?? ""));
          const value = opts.validate ? opts.validate(parsed) : (parsed as T);
          return { ok: true, value, costUsd: cost, error: null, attempt: a.name };
        } catch (e) {
          return { ok: false, value: null, costUsd: cost, error: safe(`bad model output: ${(e as Error).message}`), attempt: a.name };
        }
      }
    }
    return { ok: false, value: null, costUsd: null, error: lastError, attempt: "none" };
  } finally {
    cleanup(dir);
  }
}
