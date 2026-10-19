// Deterministic checks that combine the session with the diff.

import type { Facts } from "./facts.ts";
import { makeRelResolver } from "./git.ts";
import type { Provenance } from "./provenance.ts";
import type { FileScope } from "./scope.ts";
import type { Claim, Session } from "./types.ts";

export type TestEvidence = "passed-after-last-edit" | "failed-after-last-edit" | "ran-only-before-last-edit" | "never-ran" | "no-edits";

export interface TestCheck {
  evidence: TestEvidence;
  lastEditPrompt: number | null;
  lastTestCommand: string | null;
  testRuns: number;
}

export function checkTests(session: Session, repoRoot: string, roots: string[] = [repoRoot]): TestCheck {
  const resolve = makeRelResolver(roots.length ? roots : [repoRoot]);
  const repoEdits = session.edits.filter((e) => !e.failed && resolve(e.filePath) !== null);
  const lastEdit = repoEdits[repoEdits.length - 1];
  const tests = session.shell.filter((s) => s.isTest);
  const lastTest = tests[tests.length - 1];
  if (!lastEdit) {
    return { evidence: "no-edits", lastEditPrompt: null, lastTestCommand: lastTest?.command ?? null, testRuns: tests.length };
  }
  const after = tests.filter((t) => t.seq > lastEdit.seq);
  const lastAfter = after[after.length - 1];
  let evidence: TestEvidence;
  if (lastAfter) evidence = lastAfter.failed === false ? "passed-after-last-edit" : "failed-after-last-edit";
  else if (tests.length > 0) evidence = "ran-only-before-last-edit";
  else evidence = "never-ran";
  return {
    evidence,
    lastEditPrompt: lastEdit.afterPrompt,
    lastTestCommand: (lastAfter ?? lastTest)?.command.slice(0, 160) ?? null,
    testRuns: tests.length,
  };
}

export type ClaimVerdict = "verified" | "contradicted" | "unverified" | "needs judgment";

export function verdictForClaim(claim: Claim, tests: TestCheck): ClaimVerdict {
  if (claim.type !== "tests_pass") return "needs judgment"; // v0.1: matched against intent verdicts
  if (tests.evidence === "passed-after-last-edit") return "verified";
  if (tests.evidence === "failed-after-last-edit") return "contradicted";
  return "unverified";
}

export type FileFlag =
  | "undisclosed" // scope drift: not asked for, not linked to anything asked for, and the agent never mentioned it
  | "against-instruction" // you said not to touch it, and the agent changed it
  | "scratch-file" // a throwaway helper the agent left in a scratch folder
  | "not-from-edit-tools" // nothing in this session's edit tools wrote these lines
  | "sensitive"
  | "deleted"
  | "dependency"
  | "test-file";

/**
 * Flags per file. Scope comes from classifyScope: only drift (not asked for, not one hop from
 * anything asked for, not a lockfile or generated file) is flagged, so a test for the code you
 * asked for, or a sibling of it, is not reported as undisclosed.
 */
export function fileFlags(p: Provenance, facts: Facts, scope: Map<string, FileScope>): Map<string, FileFlag[]> {
  const out = new Map<string, FileFlag[]>();
  for (const f of p.files) {
    const flags: FileFlag[] = [];
    const s = scope.get(f.path);
    if (s?.againstInstruction) flags.push("against-instruction");
    if (f.touchedByAgent && s?.kind === "drift") flags.push("undisclosed");
    if (s?.kind === "scratch") flags.push("scratch-file");
    if (!f.touchedByAgent && f.addedLines > 0 && f.attributedLines === 0) flags.push("not-from-edit-tools");
    if (facts.sensitiveFiles.includes(f.path)) flags.push("sensitive");
    if (f.status === "deleted") flags.push("deleted");
    if (facts.dependencyFiles.includes(f.path)) flags.push("dependency");
    if (facts.testFiles.includes(f.path)) flags.push("test-file");
    out.set(f.path, flags);
  }
  return out;
}
