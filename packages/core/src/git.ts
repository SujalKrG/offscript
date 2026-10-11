// Minimal git layer: run git, pick the diff range for a session, parse a unified diff.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonPath, normPath } from "./ingest/claude-code.ts";
import type { DiffFile, Session } from "./types.ts";

export function git(repo: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", ["--no-optional-locks", "-C", repo, "-c", "core.quotePath=false", ...args], {
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

/** Every worktree of this repo (main checkout first). Agents often work in sibling worktrees. */
export function worktreeRoots(repo: string): string[] {
  const r = git(repo, ["worktree", "list", "--porcelain"]);
  const roots = r.ok
    ? r.out
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length).trim())
    : [];
  if (!roots.some((x) => canonPath(x) === canonPath(repo))) roots.unshift(repo);
  return roots;
}

/** Maps an absolute path from a transcript to a repo-relative path, via any worktree root. */
export function makeRelResolver(roots: string[]): (abs: string) => { rel: string; root: string } | null {
  const canon = roots.map((r) => ({ root: r, c: canonPath(r) })).sort((a, b) => b.c.length - a.c.length);
  return (abs: string) => {
    const n = canonPath(abs);
    for (const { root, c } of canon) if (n.startsWith(`${c}/`)) return { rel: n.slice(c.length + 1), root };
    return null;
  };
}

export interface SessionChange {
  label: string;
  commits: string[];
  uncommittedFiles: string[];
  files: DiffFile[];
  roots: string[];
}

const SLACK_BEFORE_MS = 10 * 60 * 1000;
const SLACK_AFTER_MS = 2 * 3600 * 1000;
const MAX_COMMITS = 200;

/**
 * What did this session change?
 * - commits on ANY branch, authored or committed during the session (10 min before, 2 h after),
 *   that touch at least one file the session edited (filters out parallel sessions' commits);
 * - plus uncommitted changes, in any worktree, to files the session edited.
 * Merge commits are skipped; each commit is diffed against its first parent.
 */
export function sessionChange(repo: string, session: Session, o: RangeOverrides = {}): SessionChange | null {
  const roots = worktreeRoots(repo);
  if (o.base) {
    const range: DiffRange = { base: o.base, head: o.head ?? null, label: "", commits: [] };
    return { label: `${o.base}..${o.head ?? "working tree"} (manual)`, commits: [], uncommittedFiles: [], files: diff(repo, range), roots };
  }
  const resolve = makeRelResolver(roots);
  const edited = new Map<string, Set<string>>(); // rel path -> worktree roots it was edited in
  for (const e of [...session.edits, ...(session.turnDeltas ?? [])]) {
    if (e.failed) continue;
    const r = resolve(e.filePath);
    if (!r) continue;
    const k = normPath(r.rel);
    if (!edited.has(k)) edited.set(k, new Set());
    edited.get(k)!.add(r.root);
  }
  if (edited.size === 0) return null;

  const t0 = new Date(session.startedAt).getTime() - SLACK_BEFORE_MS;
  const t1 = new Date(session.endedAt).getTime() + SLACK_AFTER_MS;
  const commits: string[] = [];
  if (!Number.isNaN(t0)) {
    const log = git(repo, [
      "log",
      "--all",
      "--no-merges",
      "--reverse",
      "--name-only",
      "--format=@@%H %at %ct",
      `--since=${new Date(t0 - 24 * 3600 * 1000).toISOString()}`,
    ]);
    if (log.ok) {
      let cur: { sha: string; inWindow: boolean; hit: boolean } | null = null;
      const flush = () => {
        if (cur?.inWindow && cur.hit && !commits.includes(cur.sha)) commits.push(cur.sha);
      };
      for (const line of log.out.split("\n")) {
        if (line.startsWith("@@")) {
          flush();
          const [sha, at, ct] = line.slice(2).split(" ");
          const a = Number(at) * 1000;
          const c = Number(ct) * 1000;
          cur = { sha: sha!, inWindow: (a >= t0 && a <= t1) || (c >= t0 && c <= t1), hit: false };
        } else if (cur && line.trim() && edited.has(normPath(line.trim()))) cur.hit = true;
      }
      flush();
    }
  }
  const dropped = Math.max(0, commits.length - MAX_COMMITS);
  const candidates = commits.slice(-MAX_COMMITS);
  // The same work often exists as several commits (rebase, cherry-pick, squash-merge into another branch).
  // git patch-id gives identical changes the same id, so each piece of work is counted once.
  const picked = uniqueByPatchId(repo, candidates);
  const duplicates = candidates.length - picked.length;

  // Net change across the picked commits, limited to files this session edited.
  // A commit often also carries other people's or other sessions' files; those are not this session's work.
  const mineOnly = (fs: DiffFile[]) => fs.filter((f) => edited.has(normPath(f.path)) || (f.oldPath !== null && edited.has(normPath(f.oldPath))));
  const otherFiles = new Set<string>();
  const byPath = new Map<string, DiffFile>();
  const key = (t: string) => t.replace(/\r$/, "").trim();
  const add = (fs: DiffFile[], mode: "net" | "dedupe") => {
    for (const f of fs) {
      const prev = byPath.get(f.path) ?? (f.oldPath ? byPath.get(f.oldPath) : undefined);
      if (!prev) {
        byPath.set(f.path, { ...f, added: [...f.added], removed: [...f.removed] });
        continue;
      }
      if (prev.path !== f.path) {
        byPath.delete(prev.path);
        prev.path = f.path;
        byPath.set(f.path, prev);
      }
      if (mode === "net") {
        // A later commit that removes a line an earlier commit added cancels it (add-then-rewrite nets out).
        const removed: typeof f.removed = [];
        for (const r of f.removed) {
          const i = prev.added.findIndex((a) => key(a.text) === key(r.text));
          if (i >= 0) prev.added.splice(i, 1);
          else removed.push(r);
        }
        prev.removed.push(...removed);
        prev.added.push(...f.added);
      } else {
        // Uncommitted edits often repeat what a picked commit already added (the same content checked out
        // or copied to another worktree). Count each occurrence once: a multiset difference, so repeated
        // lines such as "}" are not collapsed.
        prev.added.push(...multisetExtra(f.added, prev.added));
        prev.removed.push(...multisetExtra(f.removed, prev.removed));
      }
      if (f.status === "deleted") prev.status = "deleted";
      prev.binary = prev.binary || f.binary;
    }
  };
  for (const { files } of showCommits(repo, picked)) {
    const mine = mineOnly(files);
    for (const f of files) if (!mine.includes(f)) otherFiles.add(f.path);
    add(mine, "net");
  }

  // Uncommitted edits to the session's files, in whichever worktree they live.
  const uncommitted: string[] = [];
  let againstBackup = 0;
  const baselineFor = new Map<string, string | null>();
  for (const b of session.baselines ?? []) {
    const r = resolve(b.filePath);
    if (r) baselineFor.set(`${r.root}\u0000${normPath(r.rel)}`, b.backupPath);
  }
  for (const root of roots) {
    const dirty = dirtyFiles(root); // normalised key -> path as git prints it
    const mineAll = [...dirty].filter(([key]) => edited.get(key)?.has(root)).map(([, rel]) => rel);
    if (mineAll.length === 0) continue;
    // Prefer Claude Code's own backup from before the session touched the file as the base:
    // diffing against HEAD would also count changes that were already in the file when the session began.
    const mine: string[] = [];
    for (const rel of mineAll) {
      const b = baselineFor.get(`${root}\u0000${normPath(rel)}`);
      if (b === undefined) {
        mine.push(rel);
        continue;
      }
      const fromBackup = diffFromBackup(root, rel, b);
      if (fromBackup) {
        if (fromBackup !== "unchanged") {
          add([fromBackup], "dedupe");
          uncommitted.push(rel);
          againstBackup++;
        }
      } else mine.push(rel);
    }
    if (mine.length === 0) continue;
    const tracked = git(root, ["diff", "--no-color", "--no-ext-diff", "-M", "-U0", "HEAD", "--", ...mine]);
    if (tracked.ok) add(parseUnifiedDiff(tracked.out), "dedupe");
    const untracked = new Set(
      git(root, ["ls-files", "--others", "--exclude-standard", "--", ...mine])
        .out.split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    );
    add(untrackedAsAdded(root, [...untracked]), "dedupe");
    uncommitted.push(...mine);
  }

  if (picked.length === 0 && uncommitted.length === 0) return null;
  for (const [p, f] of byPath) if (f.added.length === 0 && f.removed.length === 0 && f.status === "modified" && !f.binary) byPath.delete(p);
  const parts: string[] = [];
  if (picked.length) {
    parts.push(
      `${picked.length} commit(s) touching this session's files (any branch)${duplicates ? `, ${duplicates} duplicate cop${duplicates === 1 ? "y" : "ies"} skipped` : ""}${dropped ? `, ${dropped} oldest commit(s) beyond the ${MAX_COMMITS} limit not reviewed` : ""}`,
    );
  }
  if (uncommitted.length) {
    parts.push(
      `uncommitted edits in ${uncommitted.length} of its files${againstBackup ? ` (${againstBackup} compared with Claude's backup from before the session, not HEAD)` : ""}`,
    );
  }
  if (otherFiles.size) parts.push(`${otherFiles.size} other file(s) in those commits left out (not edited in this session)`);
  return { label: parts.join(" + "), commits: picked, uncommittedFiles: uncommitted, files: [...byPath.values()], roots };
}

function dirtyFiles(repo: string): Map<string, string> {
  const r = git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  const out = new Map<string, string>();
  if (!r.ok) return out;
  for (const line of r.out.split("\n")) {
    if (line.length < 4) continue;
    const p = line.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, "");
    out.set(normPath(p), p);
  }
  return out;
}

/** Manual --base/--head range. With no head it is the working tree, including untracked files. */
export function diff(repo: string, range: DiffRange): DiffFile[] {
  const args = ["diff", "--no-color", "--no-ext-diff", "-M", "-U0", range.base];
  if (range.head) args.push(range.head);
  const r = git(repo, args);
  if (!r.ok) throw new Error(`git diff failed: ${r.err.trim()}`);
  const files = parseUnifiedDiff(r.out);
  if (!range.head) {
    const untracked = git(repo, ["ls-files", "--others", "--exclude-standard"])
      .out.split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    files.push(...untrackedAsAdded(repo, untracked));
  }
  return files;
}

/** Lines in `next` beyond what `have` already holds, counting duplicates (multiset difference). */
function multisetExtra<T extends { text: string }>(next: T[], have: T[]): T[] {
  const count = new Map<string, number>();
  for (const l of have) {
    const k = l.text.replace(/\r$/, "").trim();
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const out: T[] = [];
  for (const l of next) {
    const k = l.text.replace(/\r$/, "").trim();
    const c = count.get(k) ?? 0;
    if (c > 0) count.set(k, c - 1);
    else out.push(l);
  }
  return out;
}

/** Keep the first commit of each distinct change (same `git patch-id`), in the given order. */
function uniqueByPatchId(repo: string, shas: string[]): string[] {
  if (shas.length < 2) return shas;
  const shown = git(repo, ["show", "--no-color", "--no-ext-diff", "--format=commit %H", ...shas]);
  if (!shown.ok) return shas;
  const r = spawnSync("git", ["--no-optional-locks", "-C", repo, "patch-id", "--stable"], {
    input: shown.out,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0) return shas;
  const idOf = new Map<string, string>();
  for (const line of (r.stdout ?? "").split("\n")) {
    const [pid, sha] = line.trim().split(/\s+/);
    if (pid && sha) idOf.set(sha, pid);
  }
  const seen = new Set<string>();
  return shas.filter((sha) => {
    const pid = idOf.get(sha);
    if (!pid) return true; // empty commit or no patch: keep
    if (seen.has(pid)) return false;
    seen.add(pid);
    return true;
  });
}

/** Each commit's own diff against its first parent, all in one `git show` (merges are not in the list). */
function showCommits(repo: string, shas: string[]): { sha: string; files: DiffFile[] }[] {
  if (shas.length === 0) return [];
  const r = git(repo, ["show", "--no-color", "--no-ext-diff", "-M", "-U0", "--first-parent", "--format=@@offscript-commit %H", ...shas]);
  if (!r.ok) return [];
  const out: { sha: string; files: DiffFile[] }[] = [];
  const chunks = r.out.split(/^@@offscript-commit /m).slice(1);
  for (const chunk of chunks) {
    const nl = chunk.indexOf("\n");
    const sha = chunk.slice(0, nl < 0 ? undefined : nl).trim();
    out.push({ sha, files: parseUnifiedDiff(nl < 0 ? "" : chunk.slice(nl + 1)) });
  }
  return out;
}

/**
 * Diff a working file against Claude Code's pre-session backup (backupPath null: the file did not exist).
 * Returns "unchanged" when the file is back to how it was before the session, null when the diff fails.
 */
function diffFromBackup(root: string, rel: string, backupPath: string | null): DiffFile | "unchanged" | null {
  const path = rel.replace(/\\/g, "/");
  if (backupPath === null) return untrackedAsAdded(root, [rel])[0] ?? null;
  const r = spawnSync(
    "git",
    ["--no-optional-locks", "-c", "core.quotePath=false", "diff", "--no-index", "--no-color", "--no-ext-diff", "-U0", "--", backupPath, join(root, rel)],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (r.status !== 0 && r.status !== 1) return null; // 1 means "files differ"
  if (r.status === 0) return "unchanged";
  const parsed = parseUnifiedDiff(r.stdout ?? "");
  const f = parsed[0];
  if (!f) return "unchanged";
  return {
    ...f,
    path,
    oldPath: null,
    status: "modified",
    added: f.added.map((l) => ({ ...l, file: path })),
    removed: f.removed.map((l) => ({ ...l, file: path })),
  };
}

/** Untracked files are part of the working-tree change but not in `git diff`. */
function untrackedAsAdded(repo: string, rels: string[]): DiffFile[] {
  const out: DiffFile[] = [];
  for (const rel of rels) {
    const path = rel.replace(/\\/g, "/");
    const f: DiffFile = { path, oldPath: null, status: "added", added: [], removed: [], binary: false };
    try {
      const buf = readFileSync(join(repo, rel));
      if (buf.length > 2 * 1024 * 1024 || buf.includes(0)) f.binary = true;
      else {
        const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        for (const [i, text] of lines.entries()) f.added.push({ file: path, newLineNo: i + 1, text });
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
