// Provenance: trace every added line in the final diff to the agent edit (and so the turn
// and prompt) that wrote it. Lines no edit tool wrote are "unattributed": a human edit,
// a shell-made edit (sed, codegen, formatter), or an edit from another session.

import { canonPath, normPath } from "./ingest/claude-code.ts";
import type { DiffFile, FileEdit, Session } from "./types.ts";

export interface FileProvenance {
  path: string;
  status: DiffFile["status"];
  addedLines: number; // non-empty added lines in the final diff
  attributedLines: number;
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
  coverage: number | null; // attributed / total, null when nothing was added
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

export function traceProvenance(repoRoot: string, session: Session, files: DiffFile[]): Provenance {
  const repoNorm = canonPath(repoRoot);
  const caseFold = /^[a-z]:\//i.test(repoNorm) || process.platform === "win32";
  const fileKey = (rel: string) => (caseFold ? rel.toLowerCase() : rel);

  // file -> lineKey -> list of edits that added it
  const added = new Map<string, Map<string, FileEdit[]>>();
  const touched = new Set<string>();
  let editsOutsideRepo = 0;
  for (const e of session.edits) {
    if (e.failed) continue;
    const rel = relKey(repoNorm, e.filePath);
    if (rel === null) {
      editsOutsideRepo++;
      continue;
    }
    const k = fileKey(rel);
    touched.add(k);
    let m = added.get(k);
    if (!m) added.set(k, (m = new Map()));
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
  const shellText = session.shell.map((s) => s.command).join("\n").toLowerCase();

  const out: FileProvenance[] = [];
  let total = 0;
  let attributed = 0;
  const inDiff = new Set<string>();

  for (const f of files) {
    const k = fileKey(f.path);
    inDiff.add(k);
    if (f.oldPath) inDiff.add(fileKey(f.oldPath));
    const m = added.get(k) ?? (f.oldPath ? added.get(fileKey(f.oldPath)) : undefined);
    const turns = new Set<number>();
    let fileTotal = 0;
    let fileAttr = 0;
    for (const l of f.added) {
      const lk = lineKey(l.text);
      if (!lk) continue;
      fileTotal++;
      const writers = m?.get(lk);
      if (writers && writers.length > 0) {
        fileAttr++;
        const last = writers[writers.length - 1]!;
        turns.add(last.afterPrompt);
      }
    }
    total += fileTotal;
    attributed += fileAttr;
    const base = (f.path.split("/").pop() ?? f.path).toLowerCase();
    out.push({
      path: f.path,
      status: f.status,
      addedLines: fileTotal,
      attributedLines: fileAttr,
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
    coverage: total > 0 ? attributed / total : null,
    editsOutsideRepo,
    agentFilesNotInDiff,
  };
}
