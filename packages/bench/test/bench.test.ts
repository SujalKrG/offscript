import { expect, test } from "bun:test";
import { ADVERSARIAL_CASES, buildAdversarial, KNOWN_LIMITS_ADVERSARIAL, names, renderAdversarial, runAdversarial } from "../src/adversarial.ts";
import { buildCase } from "../src/cases.ts";
import { CATALOGUE } from "../src/catalogue.ts";
import { render, runBench } from "../src/run.ts";
import { BASELINES, type Finding, scoreCase, summarize } from "../src/score.ts";

test("smoke: 1 fixed seed for every mutation and control passes through the real pipeline (bun run bench runs 20)", async () => {
  const r = await runBench({ seeds: 1 });
  expect(r.cases.length).toBe(CATALOGUE.reduce((n, m) => n + (1 + m.controls.length) * 1, 0));
  expect(r.failures.map((f) => `${f.mutation} ${f.mode} seed ${f.seed}: ${f.details.join("; ")} ${f.error ?? ""}`)).toEqual([]);
  const text = render(r);
  expect(text).toContain("NOT measured");
  expect(text).toContain("always-flag");
}, 180_000);

test("the same seed builds the same case, a control shares the world of its injection", () => {
  const a = buildCase("tests-stale", "inject", 5);
  const b = buildCase("tests-stale", "inject", 5);
  const c = buildCase("tests-stale", "control", 5);
  expect(b.log).toEqual(a.log);
  expect(a.expected).not.toEqual(c.expected);
  expect(a.log[0]).toBe(c.log[0]); // same base file
  expect(() => buildCase("nope", "inject", 1)).toThrow("unknown mutation");
});

test("the scorer can fail: a wrong expected finding gives FN and FP, and a wrong claim type counts as both", () => {
  const actual: Finding[] = [{ check: "claim", subject: "tests", result: "unsupported" }];
  const wrong = scoreCase([{ check: "claim", subject: "tests", result: "stale" }], actual);
  expect(wrong.pass).toBe(false);
  expect([wrong.counts.fn, wrong.counts.fp, wrong.counts.tp]).toEqual([1, 1, 0]);
  // an expected problem the product called verified is a false assurance
  const assured = scoreCase([{ check: "claim", subject: "tests", result: "unsupported" }], [{ check: "claim", subject: "tests", result: "verified" }]);
  expect([assured.counts.fn, assured.counts.falseAssured]).toEqual([1, 1]);
  // an unexpected problem, a missing verification and an abstention
  expect(scoreCase([], [{ check: "flag", subject: "a.ts", result: "undisclosed" }]).counts.fp).toBe(1);
  expect(scoreCase([{ check: "claim", subject: "tests", result: "verified" }], []).counts.miss).toBe(1);
  const abstained = scoreCase([{ check: "claim", subject: "tests", result: "verified" }], [{ check: "claim", subject: "tests", result: "unverified" }]);
  expect([abstained.counts.abstain, abstained.pass]).toEqual([1, false]);
  expect(scoreCase([], [{ check: "claim", subject: "tests", result: "verified" }], true).counts.fp).toBe(1);
});

test("baselines: always-fine misses everything, always-flag names one fixed problem per check so a wrong type is a miss and a false alarm", () => {
  const ex: Finding[] = [
    { check: "claim", subject: "tests", result: "stale" },
    { check: "flag", subject: "a.ts", result: "ok" },
  ];
  expect(summarize(scoreCase(ex, BASELINES["always-fine"]!(ex)).counts).counts).toMatchObject({ tp: 0, fn: 1, tn: 1 });
  expect(scoreCase(ex, BASELINES["always-flag"]!(ex)).counts).toMatchObject({ tp: 0, fp: 2, fn: 1, tn: 0 }); // stale is not "unsupported", and the control flag is raised
  expect(scoreCase(ex, BASELINES["always-flag (oracle type)"]!(ex)).counts).toMatchObject({ tp: 1, fp: 1 });
  expect(scoreCase(ex, BASELINES["trust-the-agent"]!(ex)).counts.falseAssured).toBe(1);
});

test("coverage counts each expected decision once: a wrong-type problem is one decision, not two", () => {
  const wrong = scoreCase([{ check: "claim", subject: "tests", result: "stale" }], [{ check: "claim", subject: "tests", result: "unsupported" }]);
  expect(wrong.counts.decided).toBe(1);
  const abst = scoreCase([{ check: "claim", subject: "tests", result: "stale" }], [{ check: "claim", subject: "tests", result: "unverified" }]);
  expect(summarize({ ...wrong.counts, abstain: 1 }).coverage).toBe(0.5);
  expect(summarize(abst.counts).coverage).toBe(0);
  expect(summarize(scoreCase([], []).counts).coverage).toBeNull();
});

test("no NaN or undefined number reaches the JSON or the table when a check has no cases", () => {
  const s = summarize(scoreCase([], []).counts);
  expect(JSON.stringify(s)).not.toContain("NaN");
  expect([s.precision, s.recall, s.f1, s.falseAssurance.rate, s.coverage]).toEqual([null, null, null, null, null]);
});

test("20 seeds really vary the world: names, features and variants", () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= 20; seed++)
    seen.add(
      buildCase("constraint-violation", "inject", seed)
        .log.filter((l) => l.startsWith("prompt"))
        .join("|"),
    );
  expect(seen.size).toBeGreaterThanOrEqual(15);
}, 180_000);

test("adversarial cases: unique ids, every known limit names a real case, per-seed names never collide", () => {
  const ids = ADVERSARIAL_CASES.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThanOrEqual(40);
  for (const k of Object.keys(KNOWN_LIMITS_ADVERSARIAL)) expect(ids).toContain(k);
  for (let seed = 1; seed <= 20; seed++) {
    const n = names(seed);
    expect(new Set([n.A, n.B, n.C, n.T, n.AUTH]).size).toBe(5);
    expect(n.F).not.toBe(n.F2);
  }
});

test("adversarial: a fixed sample of cases runs through the real pipeline; failures are only the listed known misses", async () => {
  const r = await runAdversarial({ seeds: [1], pick: (i) => i % 9 === 0 });
  expect(r.results.length).toBeGreaterThan(10);
  expect(r.failures.map((f) => `${f.id} seed ${f.seed}: ${f.details.join("; ")} ${f.error ?? ""}`)).toEqual([]);
  const text = renderAdversarial(r);
  expect(text).toContain("blind to the rules");
  expect(JSON.stringify(r)).not.toContain("NaN");
  const built = buildAdversarial(ADVERSARIAL_CASES[0]!, 1);
  expect(built.steps.length).toBeGreaterThan(1);
}, 180_000);
