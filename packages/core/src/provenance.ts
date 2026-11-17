// Provenance: trace every added line in the final diff to the agent edit (and so the turn
// and prompt) that wrote it. Lines no edit tool wrote are "unattributed": a human edit,
// a shell-made edit (sed, codegen, formatter), or an edit from another session.
//
// There is one matcher (creditFile). It credits a run of added lines to an edit only when the edit's
// added lines contain that run as a contiguous sequence of trimmed lines. A lone trivial line such
// as "}" is never credited on its own, and a line that no edit explains is reported as unresolved.

import { makeRelResolver } from "./git.ts";
import { canonPath, normPath } from "./ingest/claude-code.ts";
import type { DiffFile, DiffHunkLine, FileEdit, Session } from "./types.ts";

/** One edit that could explain lines in a file: this session's own, or another session's. */
export interface EditSource {
  edit: FileEdit;
  sessionId: string;
  own: boolean;
  keys: string[]; // trimmed, non-blank added lines in order
  at: Map<string, number[]>; // key -> positions in keys
  blanksAfter: number[]; // blank lines the edit wrote between keys[i] and keys[i + 1]
}

/** Edits other agent sessions in the same repo made: file key -> edits, oldest session first. */
export type OtherSessionIndex = Map<string, EditSource[]>;

/** Who wrote one added line, with enough detail to name the edit, turn, model and session. */
export interface LineCredit {
  seq: number;
  turn: number; // prompt index (afterPrompt) of the edit
  model: string | null;
  sessionId: string;
  own: boolean; // this session, not another one
  viaBackup: boolean; // found only through Claude Code's file backups, no edit tool call
}

export interface FileCredit {
  credits: Map<number, LineCredit>; // new line number -> credit
  unresolved: number[]; // new line numbers of non-blank added lines that no edit explains
}

export interface CreditIndex {
  bySource: Map<string, EditSource[]>; // this session's edits and backup deltas by file key
  others: OtherSessionIndex;
  fileKey: (rel: string) => string;
  touched: Set<string>;
  editsOutsideRepo: number;
  sessionId: string;
  used: Map<EditSource, Set<number>>; // positions of an edit's lines already credited to a diff line
}

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

/** A line with too little content to prove anything alone: "}", "});", "end", "return;". */
export function isTrivialLine(key: string): boolean {
  return key.replace(/[^A-Za-z0-9]/g, "").length < 8;
}

function makeSource(edit: FileEdit, sessionId: string, own: boolean): EditSource {
  const keys: string[] = [];
  const at = new Map<string, number[]>();
  const blanksAfter: number[] = [];
  for (const line of edit.addedLines) {
    const k = lineKey(line);
    if (!k) {
      if (keys.length > 0) blanksAfter[keys.length - 1] = (blanksAfter[keys.length - 1] ?? 0) + 1;
      continue;
    }
    const list = at.get(k);
    if (list) list.push(keys.length);
    else at.set(k, [keys.length]);
    keys.push(k);
    blanksAfter[keys.length - 1] = 0;
  }
  return { edit, sessionId, own, keys, at, blanksAfter };
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
 * Index the edits every other session made, so a line in a shared commit that a parallel
 * session wrote is credited to that session instead of counted as untraced.
 * Sessions are ordered by start time; when two wrote the same run, the later one wins.
 */
export function buildOtherSessionIndex(repoRoot: string, sessions: Session[], roots: string[] = [repoRoot]): OtherSessionIndex {
  const { fileKey, relOf } = keyers(repoRoot, roots);
  const idx: OtherSessionIndex = new Map();
  const ordered = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const s of ordered) {
    for (const e of [...s.edits, ...(s.turnDeltas ?? [])]) {
      if (e.failed) continue;
      const rel = relOf(e.filePath);
      if (rel === null) continue;
      const k = fileKey(rel);
      const list = idx.get(k);
      if (list) list.push(makeSource(e, s.id, false));
      else idx.set(k, [makeSource(e, s.id, false)]);
    }
  }
  return idx;
}

/** This session's edit-tool calls (exact turn) then backup deltas (catch Bash-made changes), by file. */
export function buildCreditIndex(repoRoot: string, session: Session, roots: string[] = [repoRoot], others: OtherSessionIndex = new Map()): CreditIndex {
  const { fileKey, relOf } = keyers(repoRoot, roots);
  const bySource = new Map<string, EditSource[]>();
  const touched = new Set<string>();
  let editsOutsideRepo = 0;
  for (const e of [...session.edits, ...(session.turnDeltas ?? [])]) {
    if (e.failed) continue;
    const rel = relOf(e.filePath);
    if (rel === null) {
      if (e.tool !== "turn-delta") editsOutsideRepo++;
      continue;
    }
    const k = fileKey(rel);
    touched.add(k);
    const list = bySource.get(k);
    if (list) list.push(makeSource(e, session.id, true));
    else bySource.set(k, [makeSource(e, session.id, true)]);
  }
  return { bySource, others, fileKey, touched, editsOutsideRepo, sessionId: session.id, used: new Map() };
}

const MATCH_BUDGET = 400_000_000;
const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];
const isTool = (s: EditSource) => s.edit.tool !== "turn-delta";

/**
 * The one matcher. Credits the added lines of one file to edits, run by run.
 * - Added lines are split into hunks (consecutive new line numbers); blank lines never decide a match.
 * - At each position the longest run that some edit's added lines contain contiguously wins.
 * - A run is credited only if it holds at least one non-trivial line, so a lone "}" is never credited.
 * - Ties go to this session's edit-tool calls, then its backup deltas, then another session.
 *   A line seen only in this session's backups but written by another session with an edit tool
 *   belongs to that session: backups record the file, not who typed into it.
 * - Blank lines between two lines credited to the same edit are credited with them.
 * `names` is the file's path plus the names it had before (renames), so edits made under an old name still count.
 */
export function creditFile(idx: CreditIndex, names: string[], added: DiffHunkLine[]): FileCredit {
  const keys = [...new Set(names.map(idx.fileKey))];
  const ownSources = keys.flatMap((k) => idx.bySource.get(k) ?? []);
  const others = keys.flatMap((k) => idx.others.get(k) ?? []).filter((s) => s.sessionId !== idx.sessionId);
  const ownTools = ownSources.filter(isTool);
  const ownDeltas = ownSources.filter((s) => !isTool(s));
  const credits = new Map<number, LineCredit>();
  const unresolved: number[] = [];

  // Hunks: maximal groups of consecutive new line numbers.
  const groups: { no: number; key: string }[][] = [];
  for (const l of added) {
    const g = last(groups);
    const item = { no: l.newLineNo, key: lineKey(l.text) };
    if (g && last(g)!.no + 1 === l.newLineNo) g.push(item);
    else groups.push([item]);
  }

  // Matching steps left for this file. Many repeated lines make a naive scan cubic; when the budget runs out the
  // rest of the file is left unresolved (fail closed) instead of hanging.
  let budget = MATCH_BUDGET;

  for (const g of groups) {
    const nb = g.filter((x) => x.key !== "");
    // A run is credited only if it holds a non-trivial line: where the next one is, so a trivial-only tail is skipped at once.
    const nextSolid: number[] = new Array(nb.length + 1).fill(Number.POSITIVE_INFINITY);
    for (let k = nb.length - 1; k >= 0; k--) nextSolid[k] = isTrivialLine(nb[k]!.key) ? nextSolid[k + 1]! : k;
    const src = new Map<number, EditSource>();
    const at = new Map<number, number>(); // diff line -> position in its edit's lines
    for (let i = 0; i < nb.length; ) {
      // Longest contiguous match among a set of sources, and which of them reach that length.
      // An edit line explains one diff line only once: positions already credited are skipped.
      const longest = (set: EditSource[]) => {
        if (budget <= 0 || nextSolid[i] === Number.POSITIVE_INFINITY) return { len: 0, hit: [] as { s: EditSource; start: number }[], ok: false };
        let len = 0;
        let hit: { s: EditSource; start: number }[] = [];
        for (const s of set) {
          const starts = s.at.get(nb[i]!.key);
          if (!starts) continue;
          const taken = idx.used.get(s);
          let m = 0;
          let bestStart = -1;
          for (const j of starts) {
            if (taken?.has(j)) continue;
            let l = 1;
            while (i + l < nb.length && j + l < s.keys.length && s.keys[j + l] === nb[i + l]!.key && !taken?.has(j + l)) l++;
            budget -= l;
            if (l > m) {
              m = l;
              bestStart = j;
            }
          }
          if (m === 0) continue;
          if (m > len) {
            len = m;
            hit = [{ s, start: bestStart }];
          } else if (m === len) hit.push({ s, start: bestStart });
        }
        return { len, hit, ok: len > 0 && nb.slice(i, i + len).some((x) => !isTrivialLine(x.key)) };
      };
      // Evidence order: this session's edit-tool calls, then its backup deltas, then another session.
      let picked: { s: EditSource; start: number } | undefined;
      let best = 0;
      const t1 = longest(ownTools);
      if (t1.ok) {
        picked = last(t1.hit);
        best = t1.len;
      } else {
        const t2 = longest(ownDeltas);
        const t3 = longest(others);
        const oAny = last(t3.hit);
        const oTool = last(t3.hit.filter((h) => isTool(h.s)));
        if (t2.ok && !(t3.ok && oTool && oAny && oTool.s.sessionId === oAny.s.sessionId)) {
          picked = last(t2.hit);
          best = t2.len;
        } else if (t3.ok) {
          picked = oTool && oAny && oTool.s.sessionId === oAny.s.sessionId ? oTool : oAny;
          best = t3.len;
        }
      }
      if (!picked) {
        i++;
        continue;
      }
      const pick = picked.s;
      const taken = idx.used.get(pick) ?? new Set<number>();
      idx.used.set(pick, taken);
      for (let j = i; j < i + best; j++) {
        taken.add(picked.start + j - i);
        src.set(nb[j]!.no, pick);
        at.set(nb[j]!.no, picked.start + j - i);
        credits.set(nb[j]!.no, {
          seq: pick.edit.seq,
          turn: pick.edit.afterPrompt,
          model: pick.edit.model ?? null,
          sessionId: pick.sessionId,
          own: pick.own,
          viaBackup: pick.own && !isTool(pick),
        });
      }
      i += best;
    }
    // Interior blank lines ride with their neighbours when both belong to the same edit and that edit
    // wrote at least as many blank lines between them. A blank the edit did not write is not credited.
    let before: EditSource | undefined;
    let beforeAt = -1;
    let blanks: number[] = [];
    for (const x of g) {
      if (x.key === "") {
        blanks.push(x.no);
        continue;
      }
      const s = src.get(x.no);
      const p = at.get(x.no) ?? -1;
      if (s && s === before && p === beforeAt + 1 && blanks.length <= (s.blanksAfter[beforeAt] ?? 0))
        for (const b of blanks) credits.set(b, credits.get(x.no)!);
      before = s;
      beforeAt = p;
      blanks = [];
    }
    for (const x of nb) if (!credits.has(x.no)) unresolved.push(x.no);
  }
  return { credits, unresolved };
}

export function traceProvenance(
  repoRoot: string,
  session: Session,
  files: DiffFile[],
  roots: string[] = [repoRoot],
  others: OtherSessionIndex = new Map(),
): Provenance {
  const idx = buildCreditIndex(repoRoot, session, roots, others);
  const { fileKey, touched } = idx;

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
    const { credits } = creditFile(idx, f.oldPath ? [f.oldPath, f.path] : [f.path], f.added);
    const turns = new Set<number>();
    let fileTotal = 0;
    let fileAttr = 0;
    let fileOther = 0;
    let fileBackup = 0;
    for (const l of f.added) {
      if (!lineKey(l.text)) continue;
      fileTotal++;
      const c = credits.get(l.newLineNo);
      if (!c) continue;
      if (c.own) {
        fileAttr++;
        if (c.viaBackup) fileBackup++;
        turns.add(c.turn);
      } else {
        fileOther++;
        otherIds.add(c.sessionId);
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
    editsOutsideRepo: idx.editsOutsideRepo,
    agentFilesNotInDiff,
  };
}
