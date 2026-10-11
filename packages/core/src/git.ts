// Minimal git layer: run git, pick the diff range for a session, parse a unified diff.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normPath } from "./ingest/claude-code.ts";
import type { DiffFile, Session } from "./types.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function git(repo: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? (r.error ? String(r.error) : "") };
}

export function repoRoot(path: string): string | null {
  const r = git(path, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out.trim() : null;
}

export interface DiffRange {
  base: string;
  head: string | null; // null = working tree
  label: string;
  commits: string[];
}

export interface RangeOverrides {
  base?: string;
  head?: string;
}

/**
 * Pick what "the change" is for a session:
 * 1. explicit --base/--head wins;
 * 2. commits on HEAD's history made during the session (plus 2 hours) -> parent of first .. last;
 * 3. otherwise uncommitted changes against HEAD, if any;
 * 4. otherwise nothing.
 */
export function resolveRange(repo: string, session: Session, o: RangeOverrides = {}): DiffRange | null {
  if (o.base) {
    return { base: o.base, head: o.head ?? null, label: `${o.base}..${o.head ?? "working tree"} (manual)`, commits: [] };
  }
  const start = new Date(session.startedAt);
  const end = new Date(new Date(session.endedAt).getTime() + 2 * 3600 * 1000);
  if (!Number.isNaN(start.getTime())) {
    const log = git(repo, ["log", "--reverse", "--format=%H", `--since=${start.toISOString()}`, `--until=${end.toISOString()}`]);
    const commits = log.ok ? log.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    if (commits.length > 0) {
      const first = commits[0]!;
      const last = commits[commits.length - 1]!;
      const parent = git(repo, ["rev-parse", "--verify", "--quiet", `${first}^`]);
      const base = parent.ok ? parent.out.trim() : EMPTY_TREE;
      // If the session also left uncommitted edits, review up to the working tree.
      const includeTree = sessionHasDirtyFiles(repo, session);
      return {
        base,
        head: includeTree ? null : last,
        label: `${commits.length} commit(s) made during the session${includeTree ? " plus uncommitted changes" : ""}: ${short(base)}..${includeTree ? "working tree" : short(last)}`,
        commits,
      };
    }
  }
  const status = git(repo, ["status", "--porcelain"]);
  if (status.ok && status.out.trim()) {
    return { base: "HEAD", head: null, label: "uncommitted changes vs HEAD (may include work from other sessions)", commits: [] };
  }
  return null;
}

function dirtyFiles(repo: string): Set<string> {
  const r = git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  const out = new Set<string>();
  if (!r.ok) return out;
  for (const line of r.out.split("\n")) {
    if (line.length < 4) continue;
    const p = line.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, "");
    out.add(normPath(p));
  }
  return out;
}

function sessionHasDirtyFiles(repo: string, session: Session): boolean {
  const dirty = dirtyFiles(repo);
  if (dirty.size === 0) return false;
  const root = normPath(repo);
  return session.edits.some((e) => {
    const n = normPath(e.filePath);
    return n.startsWith(`${root}/`) && dirty.has(n.slice(root.length + 1));
  });
}

function short(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 8) : sha;
}

export function diff(repo: string, range: DiffRange): DiffFile[] {
  const args = ["diff", "--no-color", "--no-ext-diff", "-M", "-U0", range.base];
  if (range.head) args.push(range.head);
  const r = git(repo, args);
  if (!r.ok) throw new Error(`git diff failed: ${r.err.trim()}`);
  const files = parseUnifiedDiff(r.out);
  if (!range.head) files.push(...untrackedAsAdded(repo));
  return files;
}

/** Untracked files are part of the working-tree change but not in `git diff`. */
function untrackedAsAdded(repo: string): DiffFile[] {
  const r = git(repo, ["ls-files", "--others", "--exclude-standard"]);
  if (!r.ok) return [];
  const out: DiffFile[] = [];
  for (const rel of r.out.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const path = rel.replace(/\\/g, "/");
    const f: DiffFile = { path, oldPath: null, status: "added", added: [], removed: [], binary: false };
    try {
      const buf = readFileSync(join(repo, rel));
      if (buf.length > 2 * 1024 * 1024 || buf.includes(0)) f.binary = true;
      else {
        const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        lines.forEach((text, i) => f.added.push({ file: path, newLineNo: i + 1, text }));
      }
    } catch {
      continue;
    }
    out.push(f);
  }
  return out;
}

function stripPrefix(p: string): string {
  return p.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let newLine = 0;
  let oldLine = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      cur = {
        path: m?.[2] ?? "",
        oldPath: m?.[1] ?? null,
        status: "modified",
        added: [],
        removed: [],
        binary: false,
      };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) cur.path = line.slice("rename to ".length);
    else if (line.startsWith("Binary files ")) cur.binary = true;
    else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") cur.oldPath = stripPrefix(p);
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null") cur.path = stripPrefix(p);
      else cur.path = cur.oldPath ?? cur.path;
    } else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldLine = Number(m?.[1] ?? 0);
      newLine = Number(m?.[2] ?? 0);
    } else if (line.startsWith("+")) {
      cur.added.push({ file: cur.path, newLineNo: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      cur.removed.push({ file: cur.oldPath ?? cur.path, oldLineNo: oldLine++, text: line.slice(1) });
    }
  }
  for (const f of files) for (const l of f.added) l.file = f.path;
  return files;
}
