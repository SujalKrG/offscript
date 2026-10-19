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
import { git, repoRoot, sessionChange, worktreeRoots } from "./git.ts";
import { findSessions, parseSession } from "./ingest/claude-code.ts";
import { buildIntentLedger } from "./intent.ts";
import { claudeAvailable } from "./judge/claude-cli.ts";
import { buildOtherSessionIndex, traceProvenance } from "./provenance.ts";
import { renderSession, type SessionReport } from "./report.ts";
import { classifyScope } from "./scope.ts";
import type { Session } from "./types.ts";
import { judgeIntents } from "./verdicts.ts";

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
  const roots = worktreeRoots(root);
  const repoPaths = git(root, ["ls-files"]).out.split("\n").filter(Boolean);
  // Sessions started in the main checkout or in any of its worktrees.
  const seen = new Set<string>();
  const refs = roots
    .flatMap((r) => findSessions(r))
    .filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
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

  // Every session in the repo, parsed once, so lines a parallel session wrote are credited to it.
  const parsed = new Map<string, Session | null>();
  const getSession = (path: string) => {
    if (!parsed.has(path)) {
      try {
        parsed.set(path, parseSession(path));
      } catch {
        parsed.set(path, null);
      }
    }
    return parsed.get(path)!;
  };
  const OVERLAP_BEFORE_MS = 3 * 24 * 3600 * 1000;
  const OVERLAP_AFTER_MS = 2 * 3600 * 1000;
  const othersFor = (s: Session) => {
    const lo = new Date(s.startedAt).getTime() - OVERLAP_BEFORE_MS;
    const hi = new Date(s.endedAt).getTime() + OVERLAP_AFTER_MS;
    const list: Session[] = [];
    for (const r of refs) {
      if (r.id === s.id) continue;
      // A transcript last written before the window opened cannot overlap it: skip without parsing.
      if (r.mtimeMs < lo) continue;
      const o = getSession(r.path);
      if (!o || o.edits.length === 0) continue;
      const a = new Date(o.startedAt).getTime();
      const b = new Date(o.endedAt).getTime();
      if (b >= lo && a <= hi) list.push(o);
    }
    return buildOtherSessionIndex(root, list, roots);
  };

  const selected = args.session ? refs.filter((r) => r.id.startsWith(args.session!)) : refs;
  const summary: string[] = [];
  let done = 0;
  let totalCost = 0;

  for (const ref of selected) {
    if (done >= args.limit) break;
    const session = getSession(ref.path);
    if (!session) continue;
    if (!args.includeEmpty && (session.prompts.length === 0 || session.edits.length === 0)) continue;

    const report: SessionReport = {
      session,
      repo: root,
      range: null,
      facts: null,
      provenance: null,
      ledger: { intents: [], claims: [], confidence: "low", notes: "", backend: "none", costUsd: null, error: null },
      tests: checkTests(session, root, roots),
      flags: new Map(),
      error: null,
    };
    try {
      const change = sessionChange(root, session, { base: args.base, head: args.head });
      if (change) {
        report.range = { label: change.label };
        const files = change.files;
        report.facts = extractFacts(files);
        report.provenance = traceProvenance(root, session, files, change.roots, othersFor(session));
      }
    } catch (e) {
      report.error = (e as Error).message;
    }
    process.stdout.write(
      `- ${session.id.slice(0, 8)}: ${session.prompts.length} prompts, ${session.edits.length} edits${session.subagentFiles ? ` (${session.edits.filter((e) => e.subagent).length} by ${session.subagentFiles} subagent(s))` : ""}`,
    );
    report.ledger = buildIntentLedger(session, root, modelOk);
    totalCost += report.ledger.costUsd ?? 0;
    if (report.provenance && report.facts) {
      // Scope uses your prompts plus the intent ledger's task lines (which resolve "yes"/"do it" to what was proposed).
      report.scope = classifyScope({
        provenance: report.provenance,
        prompts: session.prompts,
        extraText: report.ledger.intents.filter((i) => i.kind === "task" && i.status === "active").map((i) => i.text),
        roots,
        repoPaths,
      });
      report.flags = fileFlags(report.provenance, report.facts, report.scope);
    }
    if (report.ledger.intents.length) report.verdicts = judgeIntents(session, report.ledger.intents, report.provenance, report.scope ?? null);

    const file = join(outDir, `${session.startedAt.slice(0, 10)}-${session.id.slice(0, 8)}.md`);
    writeFileSync(file, renderSession(report), "utf8");
    const undisclosed = [...report.flags.values()].filter((f) => f.includes("undisclosed")).length;
    const against = [...report.flags.values()].filter((f) => f.includes("against-instruction")).length;
    const cov = report.provenance?.coverage;
    console.log(
      `, ${report.ledger.intents.length} intents${report.ledger.error ? " (intent error)" : ""}, traced ${cov == null ? "n/a" : `${Math.round(cov * 100)}%`}${report.provenance?.viaBackups ? ` (${report.provenance.viaBackups} via backups)` : ""}${report.provenance?.otherSessionLines ? ` (+${report.provenance.otherSessionLines} lines from ${report.provenance.otherSessions.length} other session(s))` : ""}, ${
        report.verdicts
          ? `verdicts: ${Object.entries(report.verdicts.counts)
              .map(([k, n]) => `${n} ${k}`)
              .join(", ")}, `
          : ""
      }tests: ${report.tests.evidence}, undisclosed files: ${undisclosed}${against ? `, AGAINST YOUR INSTRUCTIONS: ${against}` : ""}`,
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
