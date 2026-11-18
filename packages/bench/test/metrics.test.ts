import { expect, test } from "bun:test";
import { abstentionCoverage, clusterBootstrap, cohenKappa, falseAssuranceRate, gwetAC1, precisionRecallF1, rawAgreement, wilson } from "../src/metrics.ts";

const rep = (l: string, n: number) => Array<string>(n).fill(l);

test("wilson: 5 of 5 is about 0.566 to 1, 0 of 10 starts at 0, no trials is everything", () => {
  const [lo, hi] = wilson(5, 5);
  expect(lo).toBeCloseTo(0.566, 3);
  expect(hi).toBeCloseTo(1, 6);
  expect(wilson(0, 10)[0]).toBe(0);
  expect(wilson(0, 10)[1]).toBeCloseTo(0.278, 3);
  expect(wilson(0, 0)).toEqual([0, 1]);
});

test("precision, recall, F1 and the empty cases", () => {
  const r = precisionRecallF1({ tp: 6, fp: 2, fn: 3 });
  expect(r.precision).toBeCloseTo(0.75, 6);
  expect(r.recall).toBeCloseTo(2 / 3, 6);
  expect(r.f1).toBeCloseTo(0.70588, 4);
  expect(precisionRecallF1({ tp: 0, fp: 0, fn: 0 })).toEqual({ precision: null, recall: null, f1: null });
  expect(precisionRecallF1({ tp: 0, fp: 1, fn: 1 }).f1).toBeNull();
});

test("false assurance and abstention coverage", () => {
  const fa = falseAssuranceRate(0, 10);
  expect(fa.rate).toBe(0);
  expect(fa.hi).toBeCloseTo(0.278, 3);
  expect(falseAssuranceRate(0, 0).rate).toBeNull();
  expect(abstentionCoverage(9, 1)).toBeCloseTo(0.9, 6);
  expect(abstentionCoverage(0, 0)).toBeNull();
});

test("agreement: the textbook 50-item kappa example (0.4) and AC1", () => {
  // both yes 20, A yes B no 5, A no B yes 10, both no 15
  const a = [...rep("y", 20), ...rep("y", 5), ...rep("n", 10), ...rep("n", 15)];
  const b = [...rep("y", 20), ...rep("n", 5), ...rep("y", 10), ...rep("n", 15)];
  expect(rawAgreement(a, b)).toBeCloseTo(0.7, 6);
  expect(cohenKappa(a, b)).toBeCloseTo(0.4, 6);
  expect(gwetAC1(a, b)).toBeCloseTo(0.406, 3); // pe = 2 * 0.55 * 0.45 = 0.495
});

test("agreement: perfect agreement gives 1 for all, AC1 holds up under imbalance where kappa collapses", () => {
  const x = ["a", "b", "a", "c", "a"];
  expect([rawAgreement(x, x), cohenKappa(x, x), gwetAC1(x, x)]).toEqual([1, 1, 1]);
  expect(cohenKappa(["a", "a"], ["a", "a"])).toBe(1);
  expect(gwetAC1(["a", "a"], ["a", "a"])).toBe(1);
  const p = [...rep("n", 98), "y", "n"];
  const q = [...rep("n", 98), "n", "y"];
  expect(rawAgreement(p, q)).toBeCloseTo(0.98, 6);
  expect(cohenKappa(p, q)).toBeLessThan(0);
  expect(gwetAC1(p, q)).toBeGreaterThan(0.97);
});

test("clusterBootstrap is deterministic for a seed, differs across seeds and stays inside the data range", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ cluster: `s${i}`, v: (i * 7) % 11 }));
  const mean = (xs: typeof items) => xs.reduce((s, x) => s + x.v, 0) / xs.length;
  const a = clusterBootstrap(items, mean, 7);
  expect(clusterBootstrap(items, mean, 7)).toEqual(a);
  expect(clusterBootstrap(items, mean, 8)).not.toEqual(a);
  expect(a[0]).toBeLessThanOrEqual(4.7);
  expect(a[1]).toBeGreaterThanOrEqual(4.7);
  expect(a[0]).toBeGreaterThanOrEqual(0);
  expect(a[1]).toBeLessThanOrEqual(10);
  expect(clusterBootstrap([], () => 1, 1).every(Number.isNaN)).toBe(false);
});
