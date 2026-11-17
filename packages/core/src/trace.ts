// Agent Trace export: one record per commit in the session's change, rebuilt from the transcript.
// Evidence rule: a line is credited only when an edit, a backup delta or a recorded shell write explains it
// (see creditFile). Lines nothing explains are counted as unresolved and left out. No "human" contributor is emitted.

import { randomUUID } from "node:crypto";
import type { SessionChange } from "./git.ts";
import { buildCreditIndex, creditFile, type OtherSessionIndex } from "./provenance.ts";
import type { Session } from "./types.ts";

// The published JSON schema (agent-trace.dev/schemas/v1/trace-record.json) requires version to match
// ^[0-9]+\.[0-9]+$, so the "0.1.0" that the prose spec shows is rejected and "0.1" is the value that validates.
export const TRACE_VERSION = "0.1";

/** Reverse-domain key for our own data inside the record's free-form `metadata`. */
export const METADATA_KEY = "io.github.sujalkrg.offscript";

// The schema caps model_id at 250 characters, counting "anthropic/"; a longer model name is left out, not cut.
const MAX_MODEL = 250 - "anthropic/".length;

export interface TraceContributor {
  type: "ai";
  model_id?: string;
}

export interface TraceConversation {
  contributor: TraceContributor;
  ranges: { start_line: number; end_line: number }[];
}

export interface TraceRecord {
  version: string;
  id: string;
  timestamp: string;
  vcs: { type: "git"; revision: string };
  tool?: { name: string; version: string };
  files: { path: string; conversations: TraceConversation[] }[];
  metadata: Record<string, unknown>;
}

export interface TraceSummary {
  commits: number;
  files: number;
  ranges: number;
  creditedLines: number;
  unresolvedLines: number;
  skippedUncommittedLines: number;
}

export interface TraceOptions {
  repoRoot: string;
  session: Session;
  change: SessionChange;
  others?: OtherSessionIndex;
  generatorVersion: string;
  now?: Date;
}

function toRanges(lines: number[]): { start_line: number; end_line: number }[] {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: { start_line: number; end_line: number }[] = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.end_line + 1 === n) prev.end_line = n;
    else out.push({ start_line: n, end_line: n });
  }
  return out;
}

export function buildTraceRecords(o: TraceOptions): { records: TraceRecord[]; summary: TraceSummary } {
  const { session, change } = o;
  const idx = buildCreditIndex(o.repoRoot, session, change.roots, o.others);
  const timestamp = (o.now ?? new Date()).toISOString();
  const summary: TraceSummary = {
    commits: 0,
    files: 0,
    ranges: 0,
    creditedLines: 0,
    unresolvedLines: 0,
    skippedUncommittedLines: change.uncommittedAddedLines,
  };
  const records: TraceRecord[] = [];
  // A file renamed in one commit keeps the edits made under its old name. Only renames up to the commit
  // being exported count, so a later rename cannot lend its old name's edits to an earlier commit.
  const renamedFrom = new Map<string, string>();
  const namesOf = (path: string) => {
    const names = [path];
    for (let p = renamedFrom.get(path); p && !names.includes(p); p = renamedFrom.get(p)) names.push(p);
    return names;
  };

  for (const commit of change.commitDiffs) {
    for (const f of commit.files) if (f.status === "renamed" && f.oldPath) renamedFrom.set(f.path, f.oldPath);
    const files: TraceRecord["files"] = [];
    const conversationSessions: Record<string, string[]> = {};
    let credited = 0;
    let unresolved = 0;
    for (const f of commit.files) {
      if (f.binary || f.added.length === 0) continue;
      const { credits, unresolved: missed } = creditFile(idx, namesOf(f.path), f.added);
      unresolved += missed.length;
      // One conversation per session and model; this session first.
      const groups = new Map<string, { sessionId: string; own: boolean; model: string | null; lines: number[] }>();
      for (const [no, c] of credits) {
        const key = `${c.sessionId}\u0000${c.model ?? ""}`;
        const g = groups.get(key) ?? { sessionId: c.sessionId, own: c.own, model: c.model, lines: [] };
        g.lines.push(no);
        groups.set(key, g);
      }
      for (const l of f.added) if (l.text.trim() !== "" && credits.has(l.newLineNo)) credited++;
      if (groups.size === 0) continue;
      const ordered = [...groups.values()].sort(
        (a, b) => Number(b.own) - Number(a.own) || a.sessionId.localeCompare(b.sessionId) || (a.model ?? "").localeCompare(b.model ?? ""),
      );
      files.push({
        path: f.path,
        conversations: ordered.map((g) => ({
          contributor: { type: "ai", ...(g.model && [...g.model].length <= MAX_MODEL ? { model_id: `anthropic/${g.model}` } : {}) },
          ranges: toRanges(g.lines),
        })),
      });
      conversationSessions[f.path] = ordered.map((g) => g.sessionId);
    }
    summary.unresolvedLines += unresolved;
    if (files.length === 0) continue;
    summary.commits++;
    summary.files += files.length;
    summary.creditedLines += credited;
    for (const f of files) for (const c of f.conversations) summary.ranges += c.ranges.length;
    records.push({
      version: TRACE_VERSION,
      id: randomUUID(),
      timestamp,
      vcs: { type: "git", revision: commit.sha },
      ...(session.cliVersion ? { tool: { name: "claude-code", version: session.cliVersion } } : {}),
      files,
      metadata: {
        [METADATA_KEY]: {
          generator: "offscript",
          generator_version: o.generatorVersion,
          derivation: "transcript",
          session_id: session.id,
          unresolved_lines: unresolved,
          skipped_uncommitted_lines: change.uncommittedAddedLines,
          conversation_sessions: conversationSessions,
        },
      },
    });
  }
  return { records, summary };
}
