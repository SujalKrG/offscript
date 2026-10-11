// Claude Code transcript reader.
// Format verified on Claude Code 2.1.x transcripts (Oct 2026):
// - one JSON record per line under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// - human prompts: type "user", origin.kind "human" (older versions: no origin), not isMeta,
//   content is a string or text blocks without tool_result blocks
// - tool results: type "user" with tool_result blocks plus a toolUseResult object;
//   edits carry filePath, structuredPatch[{oldStart,newStart,lines}], originalFile, type create|update
// Unknown record types are counted, never fatal.

import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redact } from "../redact.ts";
import type { AssistantText, FileEdit, HumanPrompt, Session, ShellRun } from "../types.ts";

const KNOWN_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "attachment",
  "progress",
  "queue-operation",
  "file-history-snapshot",
  "summary",
  "last-prompt",
  "ai-title",
  "custom-title",
  "mode",
  "atis-latch",
  "cost-state",
  "permission-mode",
  "agent-name",
  "tag",
  "file-history-delta",
  "pr-link",
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

const realCache = new Map<string, string>();

/**
 * normPath plus symlink and short-name resolution, so /var/x and /private/var/x (macOS)
 * or a Windows short name and its long form compare equal.
 * Falls back to the parent directory for files that no longer exist.
 */
export function canonPath(p: string): string {
  const hit = realCache.get(p);
  if (hit !== undefined) return hit;
  let real = p;
  try {
    real = realpathSync.native(p);
  } catch {
    try {
      real = join(realpathSync.native(dirname(p)), basename(p));
    } catch {
      real = p;
    }
  }
  const out = normPath(real);
  realCache.set(p, out);
  return out;
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
  const want = canonPath(repoRoot);
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
      const c = canonPath(cwd);
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
  timestamp: string;
}

/**
 * Subagent (Task tool) transcripts live next to the main one:
 * <project>/<sessionId>/subagents/*.jsonl. Their edits are this session's work too.
 */
export function subagentFiles(mainPath: string): string[] {
  const dir = join(dirname(mainPath), basename(mainPath).replace(/\.jsonl$/, ""));
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      try {
        const st = statSync(p);
        if (st.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (st.isFile() && n.endsWith(".jsonl")) out.push(p);
      } catch {
        // unreadable entry; skip
      }
    }
  };
  walk(dir, 0);
  return out.sort();
}

export function parseSession(path: string, opts: { subagent?: boolean } = {}): Session {
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

  // trackingPath -> version -> backup (from Claude Code's file-history records)
  const backups = new Map<string, Map<number, { file: string | null; time: string; parent: string | null }>>();
  function noteBackup(trackingPath: string, b: any) {
    if (!b || typeof b !== "object" || typeof b.version !== "number") return;
    let m = backups.get(trackingPath);
    if (!m) {
      m = new Map();
      backups.set(trackingPath, m);
    }
    if (!m.has(b.version)) {
      m.set(b.version, {
        file: typeof b.backupFileName === "string" ? b.backupFileName : null,
        time: typeof b.backupTime === "string" ? b.backupTime : "",
        parent: typeof b.realParentDir === "string" ? b.realParentDir : null,
      });
    }
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const type = rec.type as string;
    if (type === "file-history-snapshot" && rec.snapshot && typeof rec.snapshot.trackedFileBackups === "object") {
      for (const [p, b] of Object.entries(rec.snapshot.trackedFileBackups as Record<string, any>)) noteBackup(p, b);
    } else if (type === "file-history-delta" && typeof rec.trackingPath === "string") {
      noteBackup(rec.trackingPath, rec.backup);
    }
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
          pending.set(b.id, {
            name: String(b.name),
            input: (b.input ?? {}) as Record<string, unknown>,
            afterPrompt: current,
            seq: ++seq,
            timestamp: rec.timestamp ?? "",
          });
        }
      }
      continue;
    }

    if (type !== "user" || !rec.message) continue;
    const { text, hasToolResult } = blockText(rec.message.content);

    if (hasToolResult) {
      for (const b of rec.message.content as any[]) {
        if (b?.type !== "tool_result") continue;
        const call = pending.get(b.tool_use_id);
        if (!call) continue;
        pending.delete(b.tool_use_id);
        recordTool(call, b.tool_use_id, b.is_error === true, rec.toolUseResult, true);
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
        timestamp: call.timestamp,
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
      timestamp: call.timestamp,
    });
  }

  // Merge subagent work: map each call to the human prompt it followed, then re-number by time.
  let subagentCount = 0;
  if (!opts.subagent) {
    for (const f of subagentFiles(path)) {
      let sub: Session;
      try {
        sub = parseSession(f, { subagent: true });
      } catch {
        continue;
      }
      subagentCount++;
      redactions += sub.redactions;
      const label = basename(f).replace(/\.jsonl$/, "");
      const promptAt = (ts: string | undefined) => (ts ? prompts.filter((p) => p.timestamp && p.timestamp <= ts).length : prompts.length);
      for (const e of sub.edits) edits.push({ ...e, afterPrompt: promptAt(e.timestamp), subagent: label });
      for (const r of sub.shell) shell.push({ ...r, afterPrompt: promptAt(r.timestamp), subagent: label });
      if (sub.endedAt && sub.endedAt > endedAt) endedAt = sub.endedAt;
      if (sub.startedAt && (!startedAt || sub.startedAt < startedAt)) startedAt = sub.startedAt;
    }
    if (subagentCount) {
      type Ev = { ts: string; src: string; seq: number; set: (n: number) => void };
      const all: Ev[] = [
        ...edits.map((e) => ({ ts: e.timestamp ?? "", src: e.subagent ?? "", seq: e.seq, set: (n: number) => (e.seq = n) })),
        ...shell.map((r) => ({ ts: r.timestamp ?? "", src: r.subagent ?? "", seq: r.seq, set: (n: number) => (r.seq = n) })),
      ];
      // An event with no timestamp inherits the previous one from the same transcript, so every event
      // has a time and the merged order is a true total order (time, then main before subagent, then seq).
      const bySrc = new Map<string, Ev[]>();
      for (const e of all) (bySrc.get(e.src) ?? bySrc.set(e.src, []).get(e.src)!).push(e);
      for (const list of bySrc.values()) {
        list.sort((a, b) => a.seq - b.seq);
        let last = "";
        for (const e of list) {
          if (e.ts) last = e.ts;
          else e.ts = last;
        }
      }
      all.sort(
        (a, b) =>
          (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) || (a.src === b.src ? 0 : a.src === "" ? -1 : b.src === "" ? 1 : a.src < b.src ? -1 : 1) || a.seq - b.seq,
      );
      for (const [i, x] of all.entries()) x.set(i + 1);
    }
  }

  edits.sort((a, b) => a.seq - b.seq);
  shell.sort((a, b) => a.seq - b.seq);

  const sessionId = id || basename(path).replace(/\.jsonl$/, "");
  const {
    deltas: turnDeltas,
    files: backupFiles,
    baselines,
    unexplained: backupLinesUnexplained,
  } = opts.subagent ? { deltas: [], files: 0, baselines: [], unexplained: 0 } : backupDeltas(path, sessionId, cwd, backups, prompts, edits, shell);

  return {
    agent: "claude-code",
    id: sessionId,
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
    subagentFiles: subagentCount,
    turnDeltas,
    backupFiles,
    baselines,
    backupLinesUnexplained,
  };
}

/** Shell commands that can change files: scripts, in-place edits, redirects, copies, git operations, formatters. */
const SHELL_WRITES_RE =
  /\b(python3?|py|node|bun|deno|ruby|perl|php|sed|awk|tee|cp|mv|rm|install|patch|git\s+(apply|am|checkout|restore|switch|cherry-pick|merge|rebase|reset|revert|stash|pull)|npm|npx|pnpm|yarn|prettier|eslint|biome|black|ruff|gofmt|rustfmt|cargo|go|make|prisma|tsc|Set-Content|Out-File|Add-Content|Copy-Item|Move-Item)\b|>>?|--fix|--write/i;

/** Lines in `next` not in `prev`, as a multiset difference (order-free, fast, good enough for provenance). */
function multisetMinus(next: string[], prev: string[]): string[] {
  const count = new Map<string, number>();
  for (const l of prev) count.set(l, (count.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of next) {
    const c = count.get(l) ?? 0;
    if (c > 0) count.set(l, c - 1);
    else out.push(l);
  }
  return out;
}

function readLines(p: string): string[] | null {
  try {
    return readFileSync(p, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * Turn backups into per-turn changes. Claude Code backs up each tracked file before its first
 * edit and again at the start of every later turn, so the change from version i to i+1 is what
 * happened to the file during the turn that began at backup i.
 * The transcript lives at <config>/projects/<project>/<id>.jsonl; backups at <config>/file-history/<id>/.
 */
function backupDeltas(
  transcriptPath: string,
  sessionId: string,
  cwd: string,
  backups: Map<string, Map<number, { file: string | null; time: string; parent: string | null }>>,
  prompts: HumanPrompt[],
  edits: FileEdit[],
  shell: ShellRun[],
): { deltas: FileEdit[]; files: number; baselines: { filePath: string; backupPath: string | null }[]; unexplained: number } {
  // A change between two backups is only credited to the agent when the agent could have made it in
  // that window: an edit tool call on this file, or a shell command that can write files (main session
  // or a subagent). Otherwise it was most likely you or another session, and it is not credited.
  const canWrite = (abs: string, from: string, to: string) => {
    // The first backup is written as the first edit runs, a few seconds after the call is logged: allow 2 min.
    const lo = new Date(new Date(from).getTime() - 120_000).toISOString();
    const inWin = (t?: string) => !!t && t >= lo && (!to || t <= to);
    const target = canonPath(abs);
    return (
      edits.some((e) => !e.failed && inWin(e.timestamp) && canonPath(e.filePath) === target) ||
      shell.some((r) => inWin(r.timestamp) && SHELL_WRITES_RE.test(r.command))
    );
  };
  let unexplained = 0;
  const dir = join(dirname(dirname(dirname(transcriptPath))), "file-history", sessionId);
  const deltas: FileEdit[] = [];
  const baselines: { filePath: string; backupPath: string | null }[] = [];
  let files = 0;
  for (const [trackingPath, versions] of backups) {
    const sorted = [...versions.entries()].sort((a, b) => a[0] - b[0]);
    const list = sorted.map(([, v]) => v);
    const parts = trackingPath.split(/[\\/]/);
    const name = parts[parts.length - 1]!;
    const parent = list.find((v) => v.parent)?.parent ?? null;
    const abs = /^[a-z]:[\\/]|^[\\/]/i.test(trackingPath) ? trackingPath : parent ? join(parent, name) : join(cwd, ...parts);
    // Baseline only when we hold the very first backup (version 1) and can read it (or it records "did not exist").
    if (sorted[0]![0] === 1) {
      const first = list[0]!;
      if (!first.file) baselines.push({ filePath: abs, backupPath: null });
      else if (readLines(join(dir, first.file))) baselines.push({ filePath: abs, backupPath: join(dir, first.file) });
    }
    if (list.length < 2) continue;
    let prev: string[] | null = list[0]!.file ? readLines(join(dir, list[0]!.file)) : [];
    let used = false;
    for (let i = 1; i < list.length; i++) {
      const cur = list[i]!;
      const next: string[] | null = cur.file ? readLines(join(dir, cur.file)) : [];
      if (prev && next) {
        const added = multisetMinus(next, prev).filter((l) => l.trim());
        const removed = multisetMinus(prev, next).filter((l) => l.trim());
        const from = list[i - 1]!.time;
        if ((added.length || removed.length) && from && !canWrite(abs, from, cur.time)) {
          unexplained += added.length;
        } else if (added.length || removed.length) {
          deltas.push({
            seq: 0,
            afterPrompt: from ? prompts.filter((p) => p.timestamp && p.timestamp <= from).length : 0,
            toolUseId: "",
            tool: "turn-delta",
            filePath: abs,
            addedLines: added,
            removedLines: removed,
            kind: "update",
            failed: false,
            timestamp: cur.time,
          });
          used = true;
        }
      }
      prev = next;
    }
    if (used) files++;
  }
  deltas.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  return { deltas, files, baselines, unexplained };
}
