// Claude Code hook support: read the SessionEnd input, build the one-line message, install the hook into settings.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Summary } from "./summary.ts";

export interface HookInput {
  transcriptPath: string | null;
  sessionId: string | null;
  cwd: string | null;
}

/** SessionEnd hook input is a JSON object on stdin. Unknown keys are ignored. */
export function parseHookInput(text: string): HookInput {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("hook input is not valid JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("hook input is not a JSON object");
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" && o[k] !== "" ? (o[k] as string) : null);
  return { transcriptPath: str("transcript_path"), sessionId: str("session_id"), cwd: str("cwd") };
}

/** The one line a hook prints: counts that matter, then where the report is. */
export function hookMessage(id: string, s: Summary, reportPath: string | null): string {
  const bits: string[] = [];
  const add = (n: number, label: string) => {
    if (n) bits.push(`${n} ${label}`);
  };
  add(s.did.notDone, "not done");
  add(s.did.partly, "partly done");
  add(s.truth.contradicted, "contradicted");
  add(s.truth.stale + s.truth.overstated + s.truth.unsupported, "doubtful claims");
  add(s.truth.silentGaps, "silent gaps");
  add(s.scope.againstInstruction, "against your instructions");
  add(s.scope.unexplained, "unexplained files");
  const head = bits.length ? bits.join(", ") : `no problems (${s.did.done} of ${s.requests} requests done)`;
  return `offscript ${id.slice(0, 8)}: ${head}.${reportPath ? ` Report: ${reportPath}` : ""}`;
}

/** Claude Code shows `systemMessage` to the user, so the single line is a single-line JSON object. */
export const hookOutput = (message: string) => JSON.stringify({ systemMessage: message });

export function settingsPath(scope: "project" | "user", repoDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (scope === "project") return join(repoDir, ".claude", "settings.json");
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");
}

export const HOOK_TIMEOUT_SECONDS = 60;
/** One model call inside a hook must end well before Claude Code kills the hook at HOOK_TIMEOUT_SECONDS. */
export const HOOK_MODEL_TIMEOUT_MS = 30_000;
/** Claude Code writes the hook input at once; a TTY or a pipe nobody closes must not hang session end. */
export const HOOK_STDIN_TIMEOUT_MS = 5_000;

/**
 * The command Claude Code runs. Hooks run through a POSIX shell on Windows (Git Bash), where "C:\\Users\\me" loses
 * its backslashes, so the path is written with forward slashes, which Windows accepts everywhere.
 */
export function hookCommand(mainPath: string): string {
  const p = mainPath.replace(/\\/g, "/").replace(/(["$`])/g, "\\$1");
  return `bun "${p}" review --hook`;
}

export interface InstallResult {
  path: string;
  action: "created" | "added" | "updated" | "unchanged";
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isOurs = (command: unknown) => typeof command === "string" && /\breview\s+--hook\b/.test(command) && /offscript|cli[\\/]src[\\/]main\.ts/i.test(command);

/**
 * Merge a SessionEnd hook into a Claude Code settings file. Every other key is kept as is; running it again
 * changes nothing. Throws (and writes nothing) when the file exists but is not a JSON object.
 */
export function installHook(path: string, command: string): InstallResult {
  let settings: Obj = {};
  const existed = existsSync(path);
  if (existed) {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, ""); // PowerShell's Out-File writes a BOM; JSON.parse rejects it
    if (text.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${path} is not valid JSON, so it was left alone. Fix it, then run this again.`);
      }
      if (!isObj(parsed)) throw new Error(`${path} is not a JSON object, so it was left alone.`);
      settings = parsed;
    }
  }
  if (settings.hooks !== undefined && !isObj(settings.hooks)) throw new Error(`"hooks" in ${path} is not an object, so it was left alone.`);
  const hooks: Obj = isObj(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooks;
  if (hooks.SessionEnd !== undefined && !Array.isArray(hooks.SessionEnd)) throw new Error(`"hooks.SessionEnd" in ${path} is not a list, so it was left alone.`);
  const groups: unknown[] = Array.isArray(hooks.SessionEnd) ? hooks.SessionEnd : [];
  hooks.SessionEnd = groups;

  let action: InstallResult["action"] = "added";
  let found = false;
  for (const group of groups) {
    for (const h of isObj(group) && Array.isArray(group.hooks) ? group.hooks : []) {
      if (!isObj(h) || !isOurs(h.command)) continue;
      found = true;
      if (h.command !== command || h.timeout !== HOOK_TIMEOUT_SECONDS || h.type !== "command") {
        h.type = "command";
        h.command = command;
        h.timeout = HOOK_TIMEOUT_SECONDS;
        action = "updated";
      } else if (action !== "updated") action = "unchanged";
    }
  }
  if (!found) groups.push({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] });
  if (action === "unchanged") return { path, action };

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  return { path, action: !existed ? "created" : action };
}
