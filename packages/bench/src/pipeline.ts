// The real review pipeline, run over one generated case. Shared by the synthetic and the adversarial families.

import { join } from "node:path";
import { openRepo, type ReviewResult, reviewSession } from "../../core/src/review.ts";
import type { World } from "../../core/test/trace-world.ts";
import type { Finding } from "./score.ts";

const PROBLEM_FLAGS = ["undisclosed", "against-instruction"];

/** What the product reported, in the same shape as the expected findings. */
export function actualFindings(r: ReviewResult): Finding[] {
  const out: Finding[] = [];
  for (const cl of r.claims?.claims ?? []) out.push({ check: "claim", subject: cl.kind, result: cl.verdict });
  for (const [path, flags] of r.flags) for (const f of flags) if (PROBLEM_FLAGS.includes(f)) out.push({ check: "flag", subject: path, result: f });
  for (const g of r.claims?.silentGaps ?? []) out.push({ check: "gap", subject: g.intent.split(":")[0]!, result: "silent" });
  const constraints = new Set(r.report.ledger.intents.filter((i) => i.kind !== "task").map((i) => i.id));
  for (const v of r.verdicts?.verdicts ?? []) if (constraints.has(v.id)) out.push({ check: "verdict", subject: v.id, result: v.verdict });
  return out;
}

/** Run one case through the real pipeline, with CLAUDE_CONFIG_DIR pointing at the case and restored afterwards. */
export async function runCase(c: { world: World }): Promise<Finding[]> {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(c.world.base, "claude");
  try {
    const ctx = openRepo(c.world.repo, c.world.projects);
    if (!ctx) throw new Error("case repo not found");
    const ref = ctx.refs[0];
    const session = ref && ctx.getSession(ref.path);
    if (!session) throw new Error("case session not found");
    return actualFindings(await reviewSession({ ctx, session, ledger: "heuristic" }));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}
