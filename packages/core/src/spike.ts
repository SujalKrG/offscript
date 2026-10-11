#!/usr/bin/env bun
// v0.0 spike: for each recent Claude Code session in a repo, print
// intents (from the conversation only), hard facts (from git), and which turn wrote which lines.
//
// Usage:
//   bun run spike --repo C:\path\to\repo [--limit 10] [--session <id-prefix>] [--no-llm]
//                 [--base <ref> --head <ref>] [--out spike-results] [--list] [--include-empty]

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { checkTests, fileFlags } from "./checks.ts";
import { extractFacts } from "./facts.ts";
import { diff, repoRoot, resolveRange } from "./git.ts";
import { findSessions, parseSession } from "./ingest/claude-code.ts";
import { buildIntentLedger } from "./intent.ts";
import { claudeAvailable } from "./judge/claude-cli.ts";
import { traceProvenance } from "./provenance.ts";
import { renderSession, type SessionReport } from "./report.ts";

interface Args {
  repo: string;
  limit: number;
  session?: string;
  noLlm: boolean;
  base?: string;
  head?: string;
  out: string;
  list: boolean;
  includeEmpty: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { repo: process.cwd(), limit: 10, noLlm: false, out: "spike-results", list: false, includeEmpty: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const val = argv[++i];
      if (val === undefined) throw new Error(`missing value for ${k}`);
      return val;
    };
    if (k === "--repo") a.repo = v();
    else if (k === "--limit") a.limit = Number(v());
    else if (k === "--session") a.session = v();
    else if (k === "--no-llm") a.noLlm = true;
    else if (k === "--base") a.base = v();
    else if (k === "--head") a.head = v();
    else if (k === "--out") a.out = v();
    else if (k === "--list") a.list = true;
    else if (k === "--include-empty") a.includeEmpty = true;
    else if (k === "--help" || k === "-h") {
      console.log("bun run spike --repo <path> [--limit 10] [--session <id>] [--no-llm] [--base <ref> --head <ref>] [--out dir] [--list] [--include-empty]");
      process.exit(0);
    } else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

function main() {
  if (process.env.OFFSCRIPT_INNER === "1") return; // never run inside our own judge call
  const args = parseArgs(process.argv.slice(2));
  const root = repoRoot(resolve(args.repo));
  if (!root) {
    console.error(`Not a git repository: ${args.repo}`);
    process.exit(1);
  }
  const refs = findSessions(root);
  if (refs.length === 0) {
    console.error(`No Claude Code sessions found for ${root}. Looked in ~/.claude/projects (set CLAUDE_CONFIG_DIR if yours is elsewhere).`);
    process.exit(1);
  }

  if (args.list) {
    for (const r of refs) console.log(`${r.id}  ${new Date(r.mtimeMs).toISOString().slice(0, 16)}  ${(r.sizeBytes / 1024).toFixed(0)} KB  ${r.cwd}`);
    return;
  }

  const modelOk = !args.noLlm && claudeAvailable();
  if (!args.noLlm && !modelOk) {
    console.error("Claude Code CLI not found, so intents are skipped. Install/log in to Claude Code, set OFFSCRIPT_CLAUDE_BIN, or pass --no-llm.");
  }

  const outDir = join(resolve(args.out), basename(root));
  mkdirSync(outDir, { recursive: true });

  const selected = args.session ? refs.filter((r) => r.id.startsWith(args.session!)) : refs;
  const summary: string[] = [];
  let done = 0;
  let totalCost = 0;

  for (const ref of selected) {
    if (done >= args.limit) break;
    const session = parseSession(ref.path);
    if (!args.includeEmpty && (session.prompts.length === 0 || session.edits.length === 0)) continue;

    const report: SessionReport = {
      session,
      repo: root,
      range: null,
      facts: null,
      provenance: null,
      ledger: { intents: [], claims: [], confidence: "low", notes: "", backend: "none", costUsd: null, error: null },
      tests: checkTests(session, root),
      flags: new Map(),
      error: null,
    };
    try {
      report.range = resolveRange(root, session, { base: args.base, head: args.head });
      if (report.range) {
        const files = diff(root, report.range);
        report.facts = extractFacts(files);
        report.provenance = traceProvenance(root, session, files);
        report.flags = fileFlags(report.provenance, report.facts);
      }
    } catch (e) {
      report.error = (e as Error).message;
    }
    process.stdout.write(`- ${session.id.slice(0, 8)}: ${session.prompts.length} prompts, ${session.edits.length} edits`);
    report.ledger = buildIntentLedger(session, root, modelOk);
    totalCost += report.ledger.costUsd ?? 0;

    const file = join(outDir, `${session.startedAt.slice(0, 10)}-${session.id.slice(0, 8)}.md`);
    writeFileSync(file, renderSession(report), "utf8");
    const undisclosed = [...report.flags.values()].filter((f) => f.includes("undisclosed")).length;
    const cov = report.provenance?.coverage;
    console.log(
      `, ${report.ledger.intents.length} intents${report.ledger.error ? " (intent error)" : ""}, traced ${cov == null ? "n/a" : `${Math.round(cov * 100)}%`}, tests: ${report.tests.evidence}, undisclosed files: ${undisclosed}`,
    );
    summary.push(
      `| ${session.startedAt.slice(0, 10)} | [${session.id.slice(0, 8)}](./${basename(file)}) | ${session.prompts.length} | ${session.edits.length} | ${report.ledger.intents.length} | ${cov == null ? "n/a" : `${Math.round(cov * 100)}%`} | ${report.tests.evidence} | ${undisclosed} |`,
    );
    done++;
  }

  const sumFile = join(outDir, "summary.md");
  writeFileSync(
    sumFile,
    [
      `# Spike summary: ${basename(root)}`,
      "",
      `Generated ${new Date().toISOString()}. Estimated model cost: $${totalCost.toFixed(4)}.`,
      "",
      "| date | session | prompts | edits | intents | traced | tests | undisclosed files |",
      "|---|---|---|---|---|---|---|---|",
      ...summary,
      "",
      "Gate for v0.1: at least 6 of 10 sessions with intents_correct = y, and average traced >= 80%.",
      "Fill the labels at the bottom of each session file, then run `bun run spike:score`.",
      "",
    ].join("\n"),
    "utf8",
  );
  console.log(`\n${done} session report(s) written to ${outDir}`);
  if (done === 0) console.log("No sessions with both prompts and edits. Try --include-empty or another repo.");
}

main();
