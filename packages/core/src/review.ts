// The review pipeline: one session in, every check out. Shared by the spike script and the CLI.

import { resolve } from "node:path";
import { checkTests, type FileFlag, fileFlags } from "./checks.ts";
import { type ClaimReport, checkClaims } from "./claims.ts";
import { extractFacts } from "./facts.ts";
import { git, repoRoot, sessionChange, worktreeRoots } from "./git.ts";
import { claudeProjectsDir, findSessions, parseSession, type SessionRef } from "./ingest/claude-code.ts";
import { buildIntentLedger, cachedIntentLedger, heuristicLedger } from "./intent.ts";
import { buildOtherSessionIndex, traceProvenance } from "./provenance.ts";
import { renderSession, type SessionReport } from "./report.ts";
import { classifyScope } from "./scope.ts";
import type { IntentLedger, Session } from "./types.ts";
import { judgeIntents, type VerdictReport } from "./verdicts.ts";

/** Where the intent ledger comes from. */
export type LedgerMode =
  | "none" // empty ledger (spike --no-llm)
  | "model" // one fresh Claude Code call
  | "cached" // the model, behind the content-addressed cache
  | "heuristic"; // offline: one request per prompt that is not a follow-up

export type LedgerSource = "model" | "cache" | "heuristic" | "none";

/** Everything known about a repo that is shared by all sessions reviewed in it. */
export interface RepoContext {
  root: string;
  roots: string[]; // main checkout plus worktrees
  repoPaths: string[]; // git ls-files
  refs: SessionRef[]; // sessions started in the repo or any worktree, newest first
  getSession(path: string): Session | null; // parsed once, null when unreadable
  othersFor(s: Session): ReturnType<typeof buildOtherSessionIndex>;
}

const OVERLAP_BEFORE_MS = 3 * 24 * 3600 * 1000;
const OVERLAP_AFTER_MS = 2 * 3600 * 1000;

/** Open a repo for review. Null when the path is not inside a git repository. */
export function openRepo(path: string, projectsDir: string = claudeProjectsDir()): RepoContext | null {
  const top = repoRoot(resolve(path));
  if (!top) return null;
  const root = resolve(top); // git prints forward slashes on Windows; show native paths
  const roots = worktreeRoots(root);
  const repoPaths = git(root, ["ls-files"]).out.split("\n").filter(Boolean);
  // Sessions started in the main checkout or in any of its worktrees.
  const seen = new Set<string>();
  const refs = roots
    .flatMap((r) => findSessions(r, projectsDir))
    .filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Every session in the repo, parsed once, so lines a parallel session wrote are credited to it.
  const parsed = new Map<string, Session | null>();
  const getSession = (p: string) => {
    if (!parsed.has(p)) {
      try {
        parsed.set(p, parseSession(p));
      } catch {
        parsed.set(p, null);
      }
    }
    return parsed.get(p) ?? null;
  };
  const othersFor = (s: Session) => {
    const lo = new Date(s.startedAt).getTime() - OVERLAP_BEFORE_MS;
    const hi = new Date(s.endedAt).getTime() + OVERLAP_AFTER_MS;
    const list: Session[] = [];
    for (const r of refs) {
      if (r.id === s.id) continue;
      // A transcript last written before the window opened cannot overlap it: skip without parsing.
      if (r.mtimeMs < lo) continue;
      const o = getSession(r.path);
      if (!o || o.edits.length === 0) continue;
      const a = new Date(o.startedAt).getTime();
      const b = new Date(o.endedAt).getTime();
      if (b >= lo && a <= hi) list.push(o);
    }
    return buildOtherSessionIndex(root, list, roots);
  };
  return { root, roots, repoPaths, refs, getSession, othersFor };
}

export interface ReviewOptions {
  ctx: RepoContext;
  session: Session;
  ledger: LedgerMode;
  base?: string;
  head?: string;
  /** Called once the change is traced and the ledger is about to be built (the slow step). */
  onLedgerStart?: () => void;
  /** Cap on one model call. A hook has a hard budget, so it passes a short one and falls back to the heuristic ledger. */
  modelTimeoutMs?: number;
}

export interface ReviewResult {
  session: Session;
  repo: string;
  report: SessionReport;
  ledgerSource: LedgerSource;
  verdicts: VerdictReport | null;
  claims: ClaimReport | null;
  flags: Map<string, FileFlag[]>;
  markdown: string;
}

export async function reviewSession(opts: ReviewOptions): Promise<ReviewResult> {
  const { ctx, session } = opts;
  const { root, roots, repoPaths } = ctx;
  const report: SessionReport = {
    session,
    repo: root,
    range: null,
    facts: null,
    provenance: null,
    ledger: { intents: [], claims: [], confidence: "low", notes: "", backend: "none", costUsd: null, error: null },
    tests: checkTests(session, root, roots),
    flags: new Map(),
    error: null,
  };
  try {
    const change = sessionChange(root, session, { base: opts.base, head: opts.head });
    if (change) {
      report.range = { label: change.label };
      report.facts = extractFacts(change.files);
      report.provenance = traceProvenance(root, session, change.files, change.roots, ctx.othersFor(session));
    }
  } catch (e) {
    report.error = (e as Error).message;
  }

  opts.onLedgerStart?.();
  let ledgerSource: LedgerSource = "none";
  let ledger: IntentLedger;
  if (opts.ledger === "cached") {
    const r = cachedIntentLedger(session, root, opts.modelTimeoutMs);
    ledger = r.ledger;
    ledgerSource = r.hit ? "cache" : "model";
  } else if (opts.ledger === "model") {
    ledger = buildIntentLedger(session, root, true, opts.modelTimeoutMs);
    ledgerSource = "model";
  } else if (opts.ledger === "heuristic") {
    ledger = heuristicLedger(session);
    ledgerSource = "heuristic";
  } else {
    ledger = buildIntentLedger(session, root, false);
  }
  report.ledger = ledger;

  if (report.provenance && report.facts) {
    // Scope uses your prompts plus the intent ledger's task lines (which resolve "yes"/"do it" to what was proposed).
    report.scope = classifyScope({
      provenance: report.provenance,
      prompts: session.prompts,
      extraText: ledger.intents.filter((i) => i.kind === "task" && i.status === "active").map((i) => i.text),
      roots,
      repoPaths,
    });
    report.flags = fileFlags(report.provenance, report.facts, report.scope);
  }
  if (ledger.intents.length) {
    report.verdicts = judgeIntents(session, ledger.intents, report.provenance, report.scope ?? null);
    report.claims = checkClaims(session, ledger.intents, report.verdicts);
  }
  return {
    session,
    repo: root,
    report,
    ledgerSource,
    verdicts: report.verdicts ?? null,
    claims: report.claims ?? null,
    flags: report.flags,
    markdown: renderSession(report),
  };
}
