// Claude Code transcript reader.
// Format verified on Claude Code 2.1.x transcripts (Oct 2026):
// - one JSON record per line under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// - human prompts: type "user", origin.kind "human" (older versions: no origin), not isMeta,
//   content is a string or text blocks without tool_result blocks
// - tool results: type "user" with tool_result blocks plus a toolUseResult object;
//   edits carry filePath, structuredPatch[{oldStart,newStart,lines}], originalFile, type create|update
// Unknown record types are counted, never fatal.

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "../redact.ts";
import type { AssistantText, FileEdit, HumanPrompt, Session, ShellRun } from "../types.ts";

const KNOWN_TYPES = new Set([
  "user", "assistant", "system", "attachment", "progress", "queue-operation",
  "file-history-snapshot", "summary", "last-prompt", "ai-title", "custom-title", "mode",
  "atis-latch", "cost-state", "permission-mode", "agent-name", "tag",
]);

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

export const TEST_COMMAND_RE =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|bun\s+test\b|npx\s+(?:vitest|jest|playwright\s+test|mocha)\b|vitest\b|jest\b|mocha\b|playwright\s+test\b|pytest\b|python\s+-m\s+(?:pytest|unittest)\b|go\s+test\b|cargo\s+test\b|phpunit\b|php\s+artisan\s+test\b|pest\b|rspec\b|dotnet\s+test\b|mvn\s+(?:-\S+\s+)*test\b|gradle(?:w)?\s+test\b|deno\s+test\b)/i;

export function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, "projects");
}

/** Normalise a filesystem path for comparison across Windows and POSIX. */
export function normPath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:\//.test(s) || process.platform === "win32") s = s.toLowerCase();
  return s;
}

export interface SessionRef {
  id: string;
  path: string;
  cwd: string;
  mtimeMs: number;
  sizeBytes: number;
}

function readHead(path: string, bytes = 256 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function firstCwd(path: string): string | null {
  const head = readHead(path);
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (typeof rec.cwd === "string") return rec.cwd;
    } catch {
      // last line of the head buffer may be cut; ignore
    }
  }
  return null;
}

/** All Claude Code sessions whose working directory is the repo or inside it, newest first. */
export function findSessions(repoRoot: string, projectsDir = claudeProjectsDir()): SessionRef[] {
  const want = normPath(repoRoot);
  const out: SessionRef[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dir = join(projectsDir, d);
    let files: string[] = [];
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      const cwd = firstCwd(path);
      if (!cwd) continue;
      const c = normPath(cwd);
      if (c !== want && !c.startsWith(`${want}/`)) continue;
      const st = statSync(path);
      out.push({ id: f.replace(/\.jsonl$/, ""), path, cwd, mtimeMs: st.mtimeMs, sizeBytes: st.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const COMPACTION_RE = /^This session is being continued from a previous conversation/;
const NOISE_PREFIXES = ["<local-command-stdout>", "<local-command-stderr>", "Caveat: The messages below were generated"];

function blockText(content: unknown): { text: string; hasToolResult: boolean } {
  if (typeof content === "string") return { text: content, hasToolResult: false };
  if (!Array.isArray(content)) return { text: "", hasToolResult: false };
  let text = "";
  let hasToolResult = false;
  for (const b of content) {
    if (b && typeof b === "object") {
      if (b.type === "tool_result") hasToolResult = true;
      else if (b.type === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
    }
  }
  return { text, hasToolResult };
}

function splitLines(s: unknown): string[] {
  if (typeof s !== "string" || s.length === 0) return [];
  return s.replace(/\r\n/g, "\n").split("\n");
}

interface PatchHunk {
  lines?: string[];
}

function patchLines(patch: unknown): { added: string[]; removed: string[] } | null {
  if (!Array.isArray(patch) || patch.length === 0) return null;
  const added: string[] = [];
  const removed: string[] = [];
  for (const h of patch as PatchHunk[]) {
    for (const l of h.lines ?? []) {
      if (l.startsWith("+")) added.push(l.slice(1));
      else if (l.startsWith("-")) removed.push(l.slice(1));
    }
  }
  return { added, removed };
}

interface PendingTool {
  name: string;
  input: Record<string, unknown>;
  afterPrompt: number;
  seq: number;
}

export function parseSession(path: string): Session {
  const raw = readFileSync(path, "utf8");
  const prompts: HumanPrompt[] = [];
  const assistant: AssistantText[] = [];
  const edits: FileEdit[] = [];
  const shell: ShellRun[] = [];
  const pending = new Map<string, PendingTool>();
  const unknownRecordTypes: Record<string, number> = {};
  let redactions = 0;
  let compactions = 0;
  let seq = 0;
  let cwd = "";
  let gitBranch: string | null = null;
  let cliVersion: string | null = null;
  let startedAt = "";
  let endedAt = "";
  let id = "";

  const red = (s: string) => {
    const r = redact(s);
    redactions += r.count;
    return r.text;
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const type = rec.type as string;
    if (!KNOWN_TYPES.has(type)) unknownRecordTypes[type] = (unknownRecordTypes[type] ?? 0) + 1;
    if (typeof rec.sessionId === "string" && !id) id = rec.sessionId;
    if (typeof rec.cwd === "string" && !cwd) cwd = rec.cwd;
    if (typeof rec.gitBranch === "string" && rec.gitBranch && !gitBranch) gitBranch = rec.gitBranch;
    if (typeof rec.version === "string" && !cliVersion) cliVersion = rec.version;
    if (typeof rec.timestamp === "string") {
      if (!startedAt) startedAt = rec.timestamp;
      endedAt = rec.timestamp;
    }

    if (type === "assistant" && rec.message && Array.isArray(rec.message.content)) {
      const current = prompts.length;
      for (const b of rec.message.content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          assistant.push({ afterPrompt: current, uuid: rec.uuid ?? "", timestamp: rec.timestamp ?? "", text: red(b.text) });
        } else if (b.type === "tool_use" && typeof b.id === "string") {
          pending.set(b.id, { name: String(b.name), input: (b.input ?? {}) as Record<string, unknown>, afterPrompt: current, seq: ++seq });
        }
      }
      continue;
    }

    if (type !== "user" || !rec.message) continue;
    const { text, hasToolResult } = blockText(rec.message.content);

    if (hasToolResult) {
      for (const b of rec.message.content as any[]) {
        if (!b || b.type !== "tool_result") continue;
        const call = pending.get(b.tool_use_id);
        if (!call) continue;
        pending.delete(b.tool_use_id);
        recordTool(call, b.tool_use_id, b.is_error === true ? true : false, rec.toolUseResult, true);
      }
      continue;
    }

    if (rec.isMeta === true) continue;
    if (rec.origin && typeof rec.origin === "object" && rec.origin.kind && rec.origin.kind !== "human") continue;
    const cleaned = text.replace(REMINDER_RE, "").trim();
    if (!cleaned) continue;
    if (COMPACTION_RE.test(cleaned)) {
      compactions++;
      continue;
    }
    if (NOISE_PREFIXES.some((p) => cleaned.startsWith(p))) continue;
    prompts.push({ index: prompts.length + 1, uuid: rec.uuid ?? "", timestamp: rec.timestamp ?? "", text: red(cleaned) });
  }

  // Tool calls that never got a result (interrupted session): keep edits as unconfirmed.
  for (const [toolUseId, call] of pending) recordTool(call, toolUseId, false, undefined, false);

  function recordTool(call: PendingTool, toolUseId: string, isError: boolean, result: any, hasResult: boolean) {
    if (SHELL_TOOLS.has(call.name)) {
      const command = typeof call.input.command === "string" ? call.input.command : "";
      shell.push({
        seq: call.seq,
        afterPrompt: call.afterPrompt,
        toolUseId,
        command: red(command),
        isTest: TEST_COMMAND_RE.test(command),
        failed: hasResult ? isError : null,
      });
      return;
    }
    if (!EDIT_TOOLS.has(call.name)) return;
    const r = result && typeof result === "object" ? result : {};
    const filePath = String(r.filePath ?? call.input.file_path ?? call.input.notebook_path ?? "");
    if (!filePath) return;
    let added: string[] = [];
    let removed: string[] = [];
    let kind: "create" | "update" = "update";
    const fromPatch = patchLines(r.structuredPatch);
    if (call.name === "Write") {
      if (r.type === "create" || (!fromPatch && r.originalFile == null)) {
        kind = "create";
        added = splitLines(r.content ?? call.input.content);
      } else if (fromPatch) {
        ({ added, removed } = fromPatch);
      } else {
        added = splitLines(call.input.content);
      }
    } else if (fromPatch) {
      ({ added, removed } = fromPatch);
    } else if (call.name === "MultiEdit" && Array.isArray(call.input.edits)) {
      for (const e of call.input.edits as any[]) {
        added.push(...splitLines(e?.new_string));
        removed.push(...splitLines(e?.old_string));
      }
    } else if (call.name === "NotebookEdit") {
      added = splitLines(call.input.new_source);
    } else {
      added = splitLines(r.newString ?? call.input.new_string);
      removed = splitLines(r.oldString ?? call.input.old_string);
    }
    edits.push({
      seq: call.seq,
      afterPrompt: call.afterPrompt,
      toolUseId,
      tool: call.name,
      filePath,
      addedLines: added,
      removedLines: removed,
      kind,
      failed: isError,
    });
  }

  edits.sort((a, b) => a.seq - b.seq);
  shell.sort((a, b) => a.seq - b.seq);

  return {
    agent: "claude-code",
    id: id || path.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, ""),
    path,
    cwd,
    gitBranch,
    cliVersion,
    startedAt,
    endedAt,
    prompts,
    assistant,
    edits,
    shell,
    compactions,
    unknownRecordTypes,
    redactions,
  };
}
