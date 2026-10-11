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

export interface JudgeResult<T> {
  ok: boolean;
  value: T | null;
  costUsd: number | null;
  error: string | null;
  attempt: string;
}

interface Candidate {
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

export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(stripped.slice(start, end + 1));
}

export function claudeAvailable(): boolean {
  for (const c of candidates()) {
    const r = spawnSync(c.cmd, ["--version"], { encoding: "utf8", shell: c.shell, windowsHide: true, timeout: 20000 });
    if (r.status === 0) return true;
  }
  return false;
}

export function runClaudeJson<T>(opts: { system: string; input: string; model?: string; timeoutMs?: number; validate?: (v: unknown) => T }): JudgeResult<T> {
  const model = opts.model ?? process.env.OFFSCRIPT_MODEL ?? "haiku";
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
        const r = spawnSync(c.cmd, args, {
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
        const stdout = (r.stdout ?? "").trim();
        const stderr = (r.stderr ?? "").trim();
        if (r.status !== 0 && /unknown option|unrecognized|unexpected argument|error: option/i.test(stderr + stdout)) {
          lastError = `${a.name}: ${(stderr || stdout).slice(0, 300)}`;
          continue; // older CLI: retry with fewer flags
        }
        let envelope: any;
        try {
          envelope = JSON.parse(stdout);
        } catch {
          lastError = `${a.name}: CLI did not return JSON (exit ${r.status}): ${(stderr || stdout).slice(0, 300)}`;
          continue;
        }
        const cost = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null;
        if (envelope.is_error) {
          return { ok: false, value: null, costUsd: cost, error: String(envelope.result ?? "model error").slice(0, 500), attempt: a.name };
        }
        try {
          const parsed = extractJson(String(envelope.result ?? ""));
          const value = opts.validate ? opts.validate(parsed) : (parsed as T);
          return { ok: true, value, costUsd: cost, error: null, attempt: a.name };
        } catch (e) {
          return { ok: false, value: null, costUsd: cost, error: `bad model output: ${(e as Error).message}`, attempt: a.name };
        }
      }
    }
    return { ok: false, value: null, costUsd: null, error: lastError, attempt: "none" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
