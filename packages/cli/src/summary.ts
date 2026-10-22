// Turns a ReviewResult into the numbers and problem lines every output (terminal, JSON, hook line, exit code) shares.

import type { ReviewResult } from "../../core/src/review.ts";

/** How a finding is drawn: bad (x), partly done, warn (~), or a silent gap (?). Lower sorts first. */
export type Mark = "bad" | "partly" | "warn" | "gap";
const MARK_ORDER: Record<Mark, number> = { bad: 0, partly: 1, warn: 2, gap: 3 };

export interface Problem {
  mark: Mark;
  kind: "request" | "claim" | "file" | "review";
  id: string | null; // intent id for requests
  text: string; // what it is about: the request, the claim or the file
  detail: string; // one line of evidence
}

export interface Summary {
  requests: number;
  did: { done: number; partly: number; notDone: number; unclear: number };
  scope: { againstInstruction: number; unexplained: number; checked: boolean };
  truth: { contradicted: number; stale: number; overstated: number; unsupported: number; verified: number; silentGaps: number };
  tracedPct: number | null;
  problems: Problem[]; // what --fail-on problems reacts to
  notes: Problem[]; // worth a look, but not a problem; --fail-on any reacts to these too
}

const DONE = new Set(["done", "answered", "kept"]);
const NOT_DONE = new Set(["not done", "failed", "violated", "not in change"]);

/** "not asked for, never mentioned", plus the scope reason only when it says something new. */
export function undisclosedReason(reason: string | undefined): string {
  const base = "not asked for, never mentioned";
  if (!reason) return base;
  const known = new Set(["not asked for", "not mentioned", "never mentioned"]);
  const extra = reason
    .split(/,\s*/)
    .map((p) => p.trim())
    .filter((p) => p && !known.has(p.toLowerCase()));
  return extra.length ? `${base} (${extra.join(", ")})` : base;
}

export function summarize(r: ReviewResult): Summary {
  const problems: Problem[] = [];
  const notes: Problem[] = [];
  const did = { done: 0, partly: 0, notDone: 0, unclear: 0 };
  const truth = { contradicted: 0, stale: 0, overstated: 0, unsupported: 0, verified: 0, silentGaps: r.claims?.silentGaps.length ?? 0 };
  const silentIds = new Set((r.claims?.silentGaps ?? []).map((g) => g.intent.split(":")[0]));

  for (const v of r.verdicts?.verdicts ?? []) {
    if (DONE.has(v.verdict)) did.done++;
    else if (v.verdict === "partly done") did.partly++;
    else if (NOT_DONE.has(v.verdict)) did.notDone++;
    else if (v.verdict === "needs judgment") did.unclear++;
    const silent = silentIds.has(v.id);
    if (NOT_DONE.has(v.verdict) || v.verdict === "partly done") {
      const mark: Mark = NOT_DONE.has(v.verdict) ? "bad" : silent ? "gap" : "partly";
      problems.push({ mark, kind: "request", id: v.id, text: v.text, detail: `${v.verdict}${silent ? ", never mentioned" : ""}: ${v.why}` });
    } else if (v.verdict === "needs judgment") {
      notes.push({ mark: "warn", kind: "request", id: v.id, text: v.text, detail: `needs judgment: ${v.why}` });
    }
  }

  for (const c of r.claims?.claims ?? []) {
    if (c.verdict === "verified") truth.verified++;
    else if (c.verdict === "contradicted") truth.contradicted++;
    else if (c.verdict === "stale") truth.stale++;
    else if (c.verdict === "overstated") truth.overstated++;
    else if (c.verdict === "unsupported") truth.unsupported++;
    const p: Problem = {
      mark: c.verdict === "contradicted" ? "bad" : "warn",
      kind: "claim",
      id: null,
      text: c.sentence,
      detail: `${c.verdict}: ${c.evidence}`,
    };
    if (c.verdict === "unverified") notes.push(p);
    else if (c.verdict !== "verified") problems.push(p);
  }

  const scope = { againstInstruction: 0, unexplained: 0, checked: r.report.provenance !== null };
  for (const [path, flags] of r.flags) {
    const s = r.report.scope?.get(path);
    if (flags.includes("against-instruction")) {
      scope.againstInstruction++;
      problems.push({
        mark: "bad",
        kind: "file",
        id: null,
        text: path,
        detail: `changed against your instruction${s?.againstInstruction ? `: "${s.againstInstruction.text}"` : ""}`,
      });
    } else if (flags.includes("undisclosed")) {
      scope.unexplained++;
      problems.push({ mark: "warn", kind: "file", id: null, text: path, detail: undisclosedReason(s?.reason) });
    }
    if (flags.includes("sensitive")) notes.push({ mark: "warn", kind: "file", id: null, text: path, detail: "sensitive path changed" });
  }

  const facts = r.report.facts;
  if (facts) {
    const ti = facts.testIntegrity;
    if (ti.skipsAdded.length) notes.push({ mark: "warn", kind: "file", id: null, text: "tests", detail: `${ti.skipsAdded.length} skip/only added` });
    if (ti.testFilesDeleted.length)
      notes.push({ mark: "warn", kind: "file", id: null, text: "tests", detail: `${ti.testFilesDeleted.length} test file(s) deleted` });
    if (ti.assertionsRemoved > ti.assertionsAdded)
      notes.push({ mark: "warn", kind: "file", id: null, text: "tests", detail: `net assertions went down by ${ti.assertionsRemoved - ti.assertionsAdded}` });
  }
  if (r.report.error) problems.push({ mark: "bad", kind: "review", id: null, text: "review", detail: r.report.error });
  if (r.report.ledger.error)
    notes.push({ mark: "warn", kind: "review", id: null, text: "requests", detail: `intent extraction failed: ${r.report.ledger.error}` });
  if (!r.report.provenance && !r.report.error)
    notes.push({ mark: "warn", kind: "review", id: null, text: "change", detail: "no commit or uncommitted change from this session found" });

  const order = (a: Problem, b: Problem) => MARK_ORDER[a.mark] - MARK_ORDER[b.mark];
  problems.sort(order); // Array.sort is stable: evidence order is kept inside a mark
  const cov = r.report.provenance?.coverage ?? null;
  return {
    requests: r.verdicts?.verdicts.length ?? r.session.prompts.length,
    did,
    scope,
    truth,
    tracedPct: cov === null ? null : Math.round(cov * 100),
    problems,
    notes,
  };
}
