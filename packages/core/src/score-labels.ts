#!/usr/bin/env bun
// Reads your labels from spike-results/**/*.md and prints the v0.0 gate result.
// Usage: bun run spike:score [--out spike-results]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const outArg = process.argv.indexOf("--out");
const root = resolve(outArg >= 0 ? process.argv[outArg + 1] ?? "spike-results" : "spike-results");

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (name.endsWith(".md") && name !== "summary.md") out.push(p);
  }
  return out;
}

function label(text: string, key: string): string {
  const m = new RegExp(`^- ${key}[^:]*:[ \\t]*(.*)$`, "m").exec(text);
  return (m?.[1] ?? "").trim().toLowerCase();
}

let files: string[] = [];
try {
  files = walk(root);
} catch {
  console.error(`No results folder at ${root}. Run \`bun run spike\` first.`);
  process.exit(1);
}

let labelled = 0;
let intentsOk = 0;
let provOk = 0;
let flagsOk = 0;
let missed = 0;
let invented = 0;
const coverages: number[] = [];

for (const f of files) {
  const t = readFileSync(f, "utf8");
  const cov = /coverage=([0-9.]+)/.exec(t);
  if (cov) coverages.push(Number(cov[1]));
  const ic = label(t, "intents_correct");
  if (!ic) continue;
  labelled++;
  if (ic.startsWith("y")) intentsOk++;
  if (label(t, "provenance_right").startsWith("y")) provOk++;
  if (label(t, "flags_useful").startsWith("y")) flagsOk++;
  missed += Number(label(t, "intents_missed")) || 0;
  invented += Number(label(t, "intents_invented")) || 0;
}

const avgCov = coverages.length ? coverages.reduce((a, b) => a + b, 0) / coverages.length : 0;
const intentRate = labelled ? intentsOk / labelled : 0;

console.log(`Session reports: ${files.length}, labelled: ${labelled}`);
console.log(`Intents correct: ${intentsOk}/${labelled}  (missed ${missed}, invented ${invented})`);
console.log(`Provenance looked right: ${provOk}/${labelled}`);
console.log(`Flags useful: ${flagsOk}/${labelled}`);
console.log(`Average traced lines: ${Math.round(avgCov * 100)}% over ${coverages.length} session(s) with a diff`);
console.log("");
const pass = labelled >= 10 ? intentsOk >= 6 && avgCov >= 0.8 : intentRate >= 0.6 && avgCov >= 0.8;
if (labelled < 10) console.log(`Note: gate is defined on 10 labelled sessions; you have ${labelled}.`);
console.log(pass ? "GATE: PASS -> build v0.1" : "GATE: NOT YET -> check which part failed above before building more");
