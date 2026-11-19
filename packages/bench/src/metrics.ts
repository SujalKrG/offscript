// Small-sample statistics for the bench. No dependencies.

const Z = 1.96;

/** Wilson 95% score interval for k successes in n trials. Zero trials gives the whole range. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (Z * Z) / n;
  const centre = (p + (Z * Z) / (2 * n)) / d;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Precision, recall and F1 from counts. A ratio with an empty denominator is null (undefined, not zero). */
export function precisionRecallF1(c: { tp: number; fp: number; fn: number }): { precision: number | null; recall: number | null; f1: number | null } {
  const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null;
  const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { precision, recall, f1 };
}

/** Share of real problems the tool called fine, with its Wilson interval (the upper bound is the number to read). */
export function falseAssuranceRate(assured: number, problems: number): { rate: number | null; lo: number; hi: number } {
  const [lo, hi] = wilson(assured, problems);
  return { rate: problems ? assured / problems : null, lo, hi };
}

/** Share of expected decisions the tool actually made (the rest abstained). */
export function abstentionCoverage(decided: number, abstained: number): number | null {
  return decided + abstained ? decided / (decided + abstained) : null;
}

export function rawAgreement(a: string[], b: string[]): number {
  return a.length ? a.filter((x, i) => x === b[i]).length / a.length : 1;
}

function marginals(a: string[], b: string[]) {
  const labels = [...new Set([...a, ...b])];
  const share = (xs: string[], l: string) => xs.filter((x) => x === l).length / xs.length;
  return labels.map((l) => [share(a, l), share(b, l)] as const);
}

/** Cohen's kappa. Perfect agreement is 1 even when only one label was used. */
export function cohenKappa(a: string[], b: string[]): number {
  const po = rawAgreement(a, b);
  const pe = marginals(a, b).reduce((s, [pa, pb]) => s + pa * pb, 0);
  return pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
}

/** Gwet's AC1: chance agreement from the average label share, so it holds up when one label dominates. */
export function gwetAC1(a: string[], b: string[]): number {
  const po = rawAgreement(a, b);
  const m = marginals(a, b);
  if (m.length < 2) return 1;
  const pe = m.reduce((s, [pa, pb]) => s + ((pa + pb) / 2) * (1 - (pa + pb) / 2), 0) / (m.length - 1);
  return pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded percentile bootstrap that resamples whole clusters (items of one session stay together). Returns the 95% interval. */
export function clusterBootstrap<T extends { cluster: string; weight?: number }>(
  items: T[],
  statistic: (xs: T[]) => number,
  seed: number,
  B = 2000,
): [number, number] {
  const groups = new Map<string, T[]>();
  for (const it of items) groups.set(it.cluster, [...(groups.get(it.cluster) ?? []), it]);
  const clusters = [...groups.values()];
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample: T[] = [];
    for (let i = 0; i < clusters.length; i++) sample.push(...clusters[Math.floor(rng() * clusters.length)]!);
    const s = statistic(sample);
    if (!Number.isNaN(s)) stats.push(s);
  }
  stats.sort((x, y) => x - y);
  if (!stats.length) return [Number.NaN, Number.NaN];
  const at = (q: number) => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(q * stats.length)))]!;
  return [at(0.025), at(0.975)];
}
