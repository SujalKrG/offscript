#!/usr/bin/env bun
// Drift Bench. Usage: bun run bench [--seeds N] [--mutation id] [--adv-seeds N]
// Two families, reported separately and never averaged: the synthetic set (cases written with the rules in view) and the adversarial set (written blind to the rules).
// Every case goes through the real review pipeline (offline heuristic ledger) and is scored against the generator's expected findings.
// The synthetic set does NOT measure the intent ledger: the heuristic ledger is a fixed, simple baseline and the prompts are written to suit it.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderAdversarial, runAdversarial } from "./adversarial.ts";
import { buildCase } from "./cases.ts";
import { CATALOGUE, KNOWN_LIMITS, type Mode } from "./catalogue.ts";
import { runCase } from "./pipeline.ts";
import { add, BASELINES, type Counts, type Finding, type Summary, scoreCase, summarize, zero } from "./score.ts";

export interface CaseResult {
  mutation: string;
  mode: Mode;
  seed: number;
  variant: string;
  pass: boolean;
  details: string[];
  log: string[];
  expected: Finding[];
  actual: Finding[];
  error: string | null;
}

export interface BenchResult {
  seeds: number;
  cases: CaseResult[];
  byMutation: Record<string, Summary>;
  overall: Summary;
  baselines: Record<string, Summary>;
  failures: CaseResult[]; // failing cases outside KNOWN_LIMITS
  knownLimitFailures: CaseResult[];
}

export async function runBench(o: { seeds: number; mutation?: string }): Promise<BenchResult> {
  const cases: CaseResult[] = [];
  const byMutation = new Map<string, Counts>();
  const base: Record<string, Counts> = Object.fromEntries(Object.keys(BASELINES).map((k) => [k, zero()]));
  for (const m of CATALOGUE.filter((m) => !o.mutation || m.id === o.mutation)) {
    for (let seed = 1; seed <= o.seeds; seed++) {
      for (const mode of ["inject", ...m.controls] as Mode[]) {
        const c = buildCase(m.id, mode, seed);
        let actual: Finding[] = [];
        let error: string | null = null;
        try {
          actual = await runCase(c);
        } catch (e) {
          error = (e as Error).message;
        }
        const s = scoreCase(c.expected, actual, c.noClaims);
        cases.push({
          mutation: m.id,
          mode,
          seed,
          variant: c.variant,
          pass: s.pass && !error,
          details: s.details,
          log: c.log,
          expected: c.expected,
          actual,
          error,
        });
        byMutation.set(m.id, add(byMutation.get(m.id) ?? zero(), s.counts));
        for (const [name, fn] of Object.entries(BASELINES)) base[name] = add(base[name]!, scoreCase(c.expected, fn(c.expected), c.noClaims).counts);
        try {
          rmSync(c.world.base, { recursive: true, force: true, maxRetries: 3 });
        } catch {
          // best effort: the World also removes it at process exit
        }
      }
    }
  }
  const failed = cases.filter((c) => !c.pass);
  return {
    seeds: o.seeds,
    cases,
    byMutation: Object.fromEntries([...byMutation].map(([k, v]) => [k, summarize(v)])),
    overall: summarize([...byMutation.values()].reduce(add, zero())),
    baselines: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, summarize(v)])),
    failures: failed.filter((c) => !(c.mutation in KNOWN_LIMITS)),
    knownLimitFailures: failed.filter((c) => c.mutation in KNOWN_LIMITS),
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
const ci = (x: number | null, [lo, hi]: [number, number]) => (x === null ? "n/a" : `${pct(x)} [${pct(lo)}-${pct(hi)}]`);

function row(name: string, s: Summary, n?: number): string {
  const c = s.counts;
  const fa = s.falseAssurance;
  return [
    name.padEnd(26),
    n === undefined ? "" : String(n).padStart(5),
    `${c.tp}/${c.fp}/${c.fn}/${c.tn}`.padStart(13),
    ci(s.precision, s.precisionCI).padStart(15),
    ci(s.recall, s.recallCI).padStart(15),
    pct(s.f1).padStart(5),
    (c.problems ? `${c.falseAssured}/${c.problems} (<=${pct(fa.hi)})` : "0/0 (n/a)").padStart(16),
    String(c.unreported).padStart(10),
    `${c.abstain} (${pct(s.coverage)})`.padStart(12),
  ].join(" ");
}

export function render(r: BenchResult): string {
  const head = [
    "".padEnd(26),
    "cases".padStart(5),
    "TP/FP/FN/TN".padStart(13),
    "precision".padStart(15),
    "recall".padStart(15),
    "F1".padStart(5),
    "false assurance".padStart(16),
    "unreported".padStart(10),
    "abstain (cov)".padStart(12),
  ].join(" ");
  const count = (id: string) => r.cases.filter((c) => c.mutation === id).length;
  const lines = [
    `Drift Bench, synthetic set: ${r.seeds} seed(s) per mutation and control, offline heuristic ledger.`,
    "Synthetic cases are easier than real sessions. Ledger accuracy (intent extraction) is NOT measured here. Intervals are Wilson 95%.",
    "false assurance = expected problem the product called verified, kept or ok. unreported = expected problem claim the product never extracted (no warning, no assurance). Abstentions count against recall.",
    "",
    head,
    ...Object.entries(r.byMutation).map(([id, s]) => row(id, s, count(id))),
    row("overall", r.overall, r.cases.length),
    "",
    "Trivial baselines on the same cases (they never look at evidence). 'oracle type' rows are told the right problem type for every expected problem, so their recall is inflated on purpose; read the plain always-flag row.",
    head,
    ...Object.entries(r.baselines).map(([name, s]) => row(name, s)),
    "",
    `Cases: ${r.cases.length}, passed ${r.cases.filter((c) => c.pass).length}, failed outside known limits ${r.failures.length}, failed inside known limits ${r.knownLimitFailures.length}.`,
    `KNOWN_LIMITS: ${
      Object.keys(KNOWN_LIMITS).length
        ? Object.entries(KNOWN_LIMITS)
            .map(([k, v]) => `${k} (${v})`)
            .join("; ")
        : "none"
    }`,
  ];
  for (const [title, list] of [
    ["FAILED", r.failures],
    ["KNOWN LIMIT", r.knownLimitFailures],
  ] as const) {
    for (const f of list) {
      lines.push("", `${title}: ${f.mutation} ${f.mode} seed ${f.seed} (${f.variant})${f.error ? ` error: ${f.error}` : ""}`);
      lines.push(...f.details.map((d) => `  ${d}`), "  operation log:", ...f.log.map((l) => `    ${l}`));
      lines.push(`  expected: ${JSON.stringify(f.expected)}`, `  actual:   ${JSON.stringify(f.actual)}`);
    }
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => args[args.indexOf(`--${name}`) + 1];
  const seeds = args.includes("--seeds") ? Number(opt("seeds")) : 20;
  const advSeeds = args.includes("--adv-seeds") ? Number(opt("adv-seeds")) : 3;
  const mutation = args.includes("--mutation") ? opt("mutation") : undefined;
  if (!Number.isInteger(seeds) || seeds < 1 || !Number.isInteger(advSeeds) || advSeeds < 0 || (mutation && !CATALOGUE.some((m) => m.id === mutation))) {
    console.error(`usage: bun run bench [--seeds N] [--mutation ${CATALOGUE.map((m) => m.id).join("|")}] [--adv-seeds N (0 skips)]`);
    process.exit(2);
  }
  const result = await runBench({ seeds, mutation });
  const text = render(result);
  console.log(text);
  const version = (JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { version: string }).version;
  const dir = join(import.meta.dir, "../../../bench/results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `synthetic-${version}.md`), `# Drift Bench, synthetic set, v${version}\n\n\`\`\`\n${text}\n\`\`\`\n`);
  writeFileSync(join(dir, `synthetic-${version}.json`), `${JSON.stringify({ version, ...result }, null, 2)}\n`);
  let advFailed = 0;
  if (advSeeds > 0 && !mutation) {
    const adv = await runAdversarial({ seeds: Array.from({ length: advSeeds }, (_, i) => i + 1) });
    const advText = renderAdversarial(adv);
    console.log(`\n${advText}`);
    writeFileSync(join(dir, `adversarial-${version}.md`), `# Drift Bench, adversarial set (blind to the rules), v${version}\n\n\`\`\`\n${advText}\n\`\`\`\n`);
    writeFileSync(join(dir, `adversarial-${version}.json`), `${JSON.stringify({ version, ...adv }, null, 2)}\n`);
    advFailed = adv.failures.length;
  }
  process.exit(result.failures.length || advFailed ? 1 : 0);
}
