// Machine output. The shape is a contract: additive changes keep schemaVersion 1, anything else bumps it.

import type { ReviewResult } from "../../core/src/review.ts";
import { type Summary, summarize } from "./summary.ts";

export const SCHEMA_VERSION = 1;

export function toJson(r: ReviewResult, reportPath: string | null, summary: Summary = summarize(r)) {
  const p = r.report.provenance;
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: "offscript",
    session: {
      id: r.session.id,
      startedAt: r.session.startedAt,
      endedAt: r.session.endedAt,
      branch: r.session.gitBranch,
      prompts: r.session.prompts.length,
      edits: r.session.edits.length,
      repo: r.repo,
      change: r.report.range?.label ?? null,
    },
    ledger: {
      source: r.ledgerSource,
      backend: r.report.ledger.backend,
      confidence: r.report.ledger.confidence,
      costUsd: r.report.ledger.costUsd,
      error: r.report.ledger.error,
    },
    summary: {
      requests: summary.requests,
      done: summary.did.done,
      partly: summary.did.partly,
      notDone: summary.did.notDone,
      unclear: summary.did.unclear,
      againstInstruction: summary.scope.againstInstruction,
      unexplainedFiles: summary.scope.unexplained,
      contradicted: summary.truth.contradicted,
      stale: summary.truth.stale,
      overstated: summary.truth.overstated,
      unsupported: summary.truth.unsupported,
      verified: summary.truth.verified,
      silentGaps: summary.truth.silentGaps,
      tracedPercent: summary.tracedPct,
      problems: summary.problems.length,
    },
    problems: summary.problems,
    notes: summary.notes,
    requests: (r.verdicts?.verdicts ?? []).map((v) => ({ id: v.id, text: v.text, verdict: v.verdict, why: v.why, turns: v.turns, files: v.files })),
    claims: (r.claims?.claims ?? []).map((c) => ({ prompt: c.prompt, kind: c.kind, sentence: c.sentence, verdict: c.verdict, evidence: c.evidence })),
    silentGaps: r.claims?.silentGaps ?? [],
    files: (p?.files ?? []).map((f) => ({
      path: f.path,
      status: f.status,
      addedLines: f.addedLines,
      attributedLines: f.attributedLines,
      scope: r.report.scope?.get(f.path)?.kind ?? null,
      flags: r.flags.get(f.path) ?? [],
    })),
    tests: { evidence: r.report.tests.evidence, runs: r.report.tests.testRuns, lastCommand: r.report.tests.lastTestCommand },
    reportPath,
  };
}
