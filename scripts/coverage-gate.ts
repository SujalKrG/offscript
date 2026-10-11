#!/usr/bin/env bun
// Overall coverage gate over coverage/lcov.info (Bun's own threshold is per file).
// Usage: bun test --coverage --coverage-reporter=lcov && bun scripts/coverage-gate.ts [--lines 0.85] [--functions 0.85]

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name: string, def: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const minLines = opt("lines", 0.85);
const minFunctions = opt("functions", 0.85);

let lcov: string;
try {
  lcov = readFileSync("coverage/lcov.info", "utf8");
} catch {
  console.error("coverage/lcov.info not found. Run: bun test --coverage --coverage-reporter=lcov");
  process.exit(2);
}

let file = "";
const totals = { lf: 0, lh: 0, fnf: 0, fnh: 0 };
for (const line of lcov.split(/\r?\n/)) {
  if (line.startsWith("SF:")) file = line.slice(3).replace(/\\/g, "/");
  // Product code only: test helpers and fixtures do not count.
  if (/(^|\/)test\//.test(file)) continue;
  const [k, v] = line.split(":");
  const n = Number(v);
  if (k === "LF") totals.lf += n;
  else if (k === "LH") totals.lh += n;
  else if (k === "FNF") totals.fnf += n;
  else if (k === "FNH") totals.fnh += n;
}

const pct = (hit: number, found: number) => (found === 0 ? 1 : hit / found);
const lines = pct(totals.lh, totals.lf);
const functions = pct(totals.fnh, totals.fnf);
const fmt = (x: number) => `${(x * 100).toFixed(2)}%`;
console.log(`Coverage (product code): lines ${fmt(lines)} (min ${fmt(minLines)}), functions ${fmt(functions)} (min ${fmt(minFunctions)})`);

let ok = true;
if (lines < minLines) {
  console.error(`::error::Line coverage ${fmt(lines)} is below ${fmt(minLines)}`);
  ok = false;
}
if (functions < minFunctions) {
  console.error(`::error::Function coverage ${fmt(functions)} is below ${fmt(minFunctions)}`);
  ok = false;
}
process.exit(ok ? 0 : 1);
