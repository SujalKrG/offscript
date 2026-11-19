// Scoring: compare the findings the real pipeline reported with the findings the generator expected.
// A finding is identified by check + subject (a claim kind, a file path, a request id). Expected findings come from
// the generator's own model of the case, never from calling the checks.

import { falseAssuranceRate, precisionRecallF1, wilson } from "./metrics.ts";

export type Check = "claim" | "flag" | "gap" | "verdict";
export interface Finding {
  check: Check;
  subject: string;
  result: string;
}

/** Results that mean "the product reports a problem". Everything else is an assurance ("verified", "kept", "ok") or an abstention. */
const PROBLEMS: Record<Check, string[]> = {
  claim: ["contradicted", "stale", "overstated", "unsupported"],
  flag: ["undisclosed", "against-instruction"],
  gap: ["silent"],
  verdict: ["violated"],
};
/** The product declined to decide. Reported separately, excluded from accuracy. */
const ABSTAIN = ["unverified", "needs judgment", "not checked"];

export const isProblem = (check: Check, result: string) => PROBLEMS[check].includes(result);
const key = (f: Finding) => `${f.check}|${f.subject}`;

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  miss: number; // a clean control expected a verification the product never produced
  abstain: number; // decisions expected, product abstained
  decided: number; // expected decisions the product made (each expected finding once; not inflated by a wrong-type problem counted as FN and FP)
  problems: number; // expected problems, including ones the product abstained on (denominator of recall and of the false-assurance rate)
  abstainProblems: number; // expected problems the product abstained on (counted in problems, and as misses in recall)
  falseAssured: number; // expected problem, product said verified / kept / ok
  unreported: number; // expected problem claim the product never extracted: no warning and no assurance (not in falseAssured)
}
export const zero = (): Counts => ({
  tp: 0,
  fp: 0,
  fn: 0,
  tn: 0,
  miss: 0,
  abstain: 0,
  decided: 0,
  problems: 0,
  abstainProblems: 0,
  falseAssured: 0,
  unreported: 0,
});
export function add(a: Counts, b: Counts): Counts {
  const out = zero();
  for (const k of Object.keys(out) as (keyof Counts)[]) out[k] = a[k] + b[k];
  return out;
}

export interface CaseScore {
  counts: Counts;
  pass: boolean;
  details: string[];
}

/** noClaims: the case expects no claim to be extracted at all, so any reported claim is a false positive. */
export function scoreCase(expected: Finding[], actual: Finding[], noClaims = false): CaseScore {
  const got = new Map<string, string>();
  for (const f of actual) {
    const prev = got.get(key(f));
    if (prev === undefined || (!isProblem(f.check, prev) && isProblem(f.check, f.result))) got.set(key(f), f.result); // a problem wins over an assurance
  }
  const c = zero();
  const details: string[] = [];
  for (const e of expected) {
    const a = got.get(key(e)) ?? (e.check === "flag" || e.check === "gap" ? "ok" : "missing"); // no flag and no silent gap is the product saying ok
    if (ABSTAIN.includes(a)) {
      c.abstain++;
      if (isProblem(e.check, e.result)) {
        c.problems++;
        c.abstainProblems++;
      }
      details.push(`abstained on ${key(e)}: expected ${e.result}, got ${a}`);
    } else if (isProblem(e.check, e.result)) {
      c.decided++;
      c.problems++;
      if (a === e.result) c.tp++;
      else {
        c.fn++;
        details.push(`missed ${key(e)}: expected ${e.result}, got ${a}`);
        if (isProblem(e.check, a)) c.fp++;
        else if (a === "missing") c.unreported++;
        else c.falseAssured++;
      }
    } else if (isProblem(e.check, a)) {
      c.decided++;
      c.fp++;
      details.push(`false alarm ${key(e)}: expected ${e.result}, got ${a}`);
    } else if (a === "missing") {
      c.decided++;
      c.miss++;
      details.push(`no result for ${key(e)}: expected ${e.result}`);
    } else {
      c.decided++;
      c.tn++;
    }
  }
  const expectedKeys = new Set(expected.map(key));
  for (const [k, a] of got) {
    const check = k.split("|")[0] as Check;
    if (expectedKeys.has(k) || !(isProblem(check, a) || (noClaims && check === "claim"))) continue;
    c.fp++;
    details.push(`unexpected ${k}: ${a}`);
  }
  return { counts: c, pass: c.fp + c.fn + c.miss + c.abstain === 0, details };
}

/** What a baseline that never looks at evidence would report for a case, from the case's expected structure. */
export const BASELINES: Record<string, (expected: Finding[]) => Finding[]> = {
  "always-fine": () => [],
  // The oracle-type variants are generous: they get the problem type right on every expected problem, so only their false alarms count against them.
  "always-flag (oracle type)": (ex) => ex.map((e) => ({ ...e, result: isProblem(e.check, e.result) ? e.result : PROBLEMS[e.check][0]! })),
  // Fair: one fixed problem per check, whatever the case is. A wrong type is both a miss and a false alarm.
  "always-flag": (ex) => ex.map((e) => ({ ...e, result: PROBLEMS[e.check][0]! })),
  "reply-text-only (oracle type)": (ex) =>
    ex.filter((e) => e.check === "claim").map((e) => ({ ...e, result: isProblem(e.check, e.result) ? e.result : "unsupported" })),
  "trust-the-agent": (ex) => ex.filter((e) => e.check === "claim").map((e) => ({ ...e, result: "verified" })),
};

export interface Summary {
  counts: Counts;
  precision: number | null;
  precisionCI: [number, number];
  recall: number | null;
  recallCI: [number, number];
  f1: number | null;
  falseAssurance: { rate: number | null; lo: number; hi: number };
  coverage: number | null; // share of expected decisions the product actually made
}

export function summarize(c: Counts): Summary {
  const { precision, recall, f1 } = precisionRecallF1({ tp: c.tp, fp: c.fp, fn: c.fn + c.abstainProblems });
  return {
    counts: c,
    precision,
    precisionCI: wilson(c.tp, c.tp + c.fp),
    recall,
    recallCI: wilson(c.tp, c.tp + c.fn + c.abstainProblems),
    f1,
    falseAssurance: falseAssuranceRate(c.falseAssured, c.problems),
    coverage: c.decided + c.abstain ? c.decided / (c.decided + c.abstain) : null,
  };
}
