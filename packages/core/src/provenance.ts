// Provenance: trace every added line in the final diff to the agent edit (and so the turn
// and prompt) that wrote it. Lines no edit tool wrote are "unattributed": a human edit,
// a shell-made edit (sed, codegen, formatter), or an edit from another session.

import { makeRelResolver } from "./git.ts";
import { canonPath, normPath } from "./ingest/claude-code.ts";
import type { DiffFile, FileEdit, Session } from "./types.ts";

/** Lines other agent sessions in the same repo wrote: file -> line -> session id. */
export type OtherSessionIndex = Map<string, Map<string, string>> & { byTool?: Map<string, Map<string, string>> };

export interface FileProvenance {
  path: string;
  status: DiffFile["status"];
  addedLines: number; // non-empty added lines in the final diff
  attributedLines: number; // written by this session
  otherSessionLines: number; // not this session, but written by another agent session in this repo
  viaBackups: number; // of attributedLines, found only through Claude Code's file backups (Bash scripts, etc.)
  turns: number[]; // prompt indices whose turns wrote lines that survived
  touchedByAgent: boolean; // any edit tool call on this file in the session
  shellMentioned: boolean; // a shell command in the session named this file
  inPrompts: boolean; // the user mentioned the file in a prompt
  inAgentText: boolean; // the agent mentioned the file in its messages
}

export interface Provenance {
  files: FileProvenance[];
  totalAddedLines: number;
  attributedLines: number;
  otherSessionLines: number;
  viaBackups: number;
  otherSessions: string[]; // ids of other sessions whose lines ended up in this change
  coverage: number | null; // attributed / (total - otherSessionLines), null when nothing is left
  editsOutsideRepo: number;
  agentFilesNotInDiff: string[]; // agent edited, but nothing left in the final diff
}

function lineKey(s: string): string {
  return s.replace(/\r$/, "").trim();
}

function relKey(repoNorm: string, absOrRel: string): string | null {
  const n = /^[a-z]:[\\/]|^\//i.test(absOrRel) ? canonPath(absOrRel) : normPath(absOrRel);
  if (n.startsWith(`${repoNorm}/`)) return n.slice(repoNorm.length + 1);
  if (!/^[a-z]:\//i.test(n) && !n.startsWith("/")) return n; // already relative
  return null;
}

function mentions(haystack: string, path: string): boolean {
  const lower = haystack.toLowerCase();
  const p = path.toLowerCase();
  if (lower.includes(p)) return true;
  const base = p.split("/").pop() ?? p;
  if (base.length >= 4 && lower.includes(base)) return true;
  const stem = base.replace(/\.[^.]+$/, "");
  return stem.length >= 5 && new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower);
}

function keyers(repoRoot: string, roots: string[]) {
  const repoNorm = canonPath(repoRoot);
  const resolve = makeRelResolver(roots.length ? roots : [repoRoot]);
  const caseFold = /^[a-z]:\//i.test(repoNorm) || process.platform === "win32";
  const fileKey = (rel: string) => (caseFold ? rel.toLowerCase() : rel);
  const relOf = (abs: string) => resolve(abs)?.rel ?? relKey(repoNorm, abs);
  return { repoNorm, fileKey, relOf };
}

/**
 * Index the lines every other session wrote, so a line in a shared commit that a parallel
 * session wrote is credited to that session instead of counted as untraced.
 * Later sessions win when two wrote the same line.
 */
export function buildOtherSessionIndex(repoRoot: string, sessions: Session[], roots: string[] = [repoRoot]): OtherSessionIndex {
  const { fileKey, relOf } = keyers(repoRoot, roots);
  const idx: OtherSessionIndex = new Map();
  const byTool = new Map<string, Map<string, string>>(); // only lines written with an edit tool (exact evidence)
  idx.byTool = byTool;
  const ordered = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const s of ordered) {
    for (const e of [...s.edits, ...(s.turnDeltas ?? [])]) {
      if (e.failed) continue;
      const rel = relOf(e.filePath);
      if (rel === null) continue;
      const k = fileKey(rel);
      let m = idx.get(k);
      if (!m) {
        m = new Map();
        idx.set(k, m);
      }
      let t = byTool.get(k);
      if (!t && e.tool !== "turn-delta") {
        t = new Map();
        byTool.set(k, t);
      }
      for (const line of e.addedLines) {
        const lk = lineKey(line);
        if (!lk) continue;
        m.set(lk, s.id);
        if (e.tool !== "turn-delta") t!.set(lk, s.id);
      }
    }
  }
  return idx;
}

export function traceProvenance(
  repoRoot: string,
  session: Session,
  files: DiffFile[],
  roots: string[] = [repoRoot],
  others: OtherSessionIndex = new Map(),
): Provenance {
  const { fileKey, relOf } = keyers(repoRoot, roots);
  const othersByTool = others.byTool ?? new Map<string, Map<string, string>>();

  // file -> lineKey -> list of edits that added it
  const added = new Map<string, Map<string, FileEdit[]>>();
  const touched = new Set<string>();
  let editsOutsideRepo = 0;
  // Edit-tool calls first (exact turn), then backup deltas (catch Bash-made changes).
  for (const e of [...session.edits, ...(session.turnDeltas ?? [])]) {
    if (e.failed) continue;
    const rel = relOf(e.filePath);
    if (rel === null) {
      if (e.tool !== "turn-delta") editsOutsideRepo++;
      continue;
    }
    const k = fileKey(rel);
    touched.add(k);
    let m = added.get(k);
    if (!m) {
      m = new Map();
      added.set(k, m);
    }
    for (const line of e.addedLines) {
      const lk = lineKey(line);
      if (!lk) continue;
      const list = m.get(lk);
      if (list) list.push(e);
      else m.set(lk, [e]);
    }
  }

  const promptText = session.prompts.map((p) => p.text).join("\n");
  const agentText = session.assistant.map((a) => a.text).join("\n");
  const shellText = session.shell
    .map((s) => s.command)
    .join("\n")
    .toLowerCase();

  const out: FileProvenance[] = [];
  let total = 0;
  let attributed = 0;
  let otherTotal = 0;
  let backupTotal = 0;
  const otherIds = new Set<string>();
  const inDiff = new Set<string>();

  for (const f of files) {
    const k = fileKey(f.path);
    inDiff.add(k);
    if (f.oldPath) inDiff.add(fileKey(f.oldPath));
    const m = added.get(k) ?? (f.oldPath ? added.get(fileKey(f.oldPath)) : undefined);
    const turns = new Set<number>();
    let fileTotal = 0;
    let fileAttr = 0;
    let fileOther = 0;
    let fileBackup = 0;
    const om = others.get(k) ?? (f.oldPath ? others.get(fileKey(f.oldPath)) : undefined);
    for (const l of f.added) {
      const lk = lineKey(l.text);
      if (!lk) continue;
      fileTotal++;
      const writers = m?.get(lk);
      const toolWriters = writers?.filter((w) => w.tool !== "turn-delta") ?? [];
      const otherWriter = om?.get(lk);
      // A line seen only in this session's backups, but written by another session with an edit tool,
      // belongs to that session: backups record the file, not who typed into it.
      if (
        writers &&
        writers.length > 0 &&
        toolWriters.length === 0 &&
        otherWriter &&
        otherWriter !== session.id &&
        othersByTool.get(k)?.get(lk) === otherWriter
      ) {
        fileOther++;
        otherIds.add(otherWriter);
        continue;
      }
      if (writers && writers.length > 0) {
        fileAttr++;
        const tools = writers.filter((w) => w.tool !== "turn-delta");
        if (tools.length === 0) fileBackup++;
        const last = (tools.length ? tools : writers)[(tools.length ? tools : writers).length - 1]!;
        turns.add(last.afterPrompt);
        continue;
      }
      const other = om?.get(lk);
      if (other && other !== session.id) {
        fileOther++;
        otherIds.add(other);
      }
    }
    total += fileTotal;
    attributed += fileAttr;
    otherTotal += fileOther;
    backupTotal += fileBackup;
    const base = (f.path.split("/").pop() ?? f.path).toLowerCase();
    out.push({
      path: f.path,
      status: f.status,
      addedLines: fileTotal,
      attributedLines: fileAttr,
      otherSessionLines: fileOther,
      viaBackups: fileBackup,
      turns: [...turns].sort((a, b) => a - b),
      touchedByAgent: touched.has(k) || (f.oldPath ? touched.has(fileKey(f.oldPath)) : false),
      shellMentioned: base.length >= 3 && shellText.includes(base),
      inPrompts: mentions(promptText, f.path),
      inAgentText: mentions(agentText, f.path),
    });
  }

  const agentFilesNotInDiff = [...touched].filter((k) => !inDiff.has(k)).sort();

  return {
    files: out,
    totalAddedLines: total,
    attributedLines: attributed,
    otherSessionLines: otherTotal,
    viaBackups: backupTotal,
    otherSessions: [...otherIds].sort(),
    coverage: total - otherTotal > 0 ? attributed / (total - otherTotal) : null,
    editsOutsideRepo,
    agentFilesNotInDiff,
  };
}
