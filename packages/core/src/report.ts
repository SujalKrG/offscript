// Markdown report for one session, with a labelling block for the spike gate.

import type { TestCheck } from "./checks.ts";
import { type FileFlag, verdictForClaim } from "./checks.ts";
import type { ClaimReport } from "./claims.ts";
import type { Facts } from "./facts.ts";
import type { Provenance } from "./provenance.ts";
import type { FileScope } from "./scope.ts";
import type { IntentLedger, Session } from "./types.ts";
import type { VerdictReport } from "./verdicts.ts";

export interface SessionReport {
  session: Session;
  repo: string;
  range: { label: string } | null;
  facts: Facts | null;
  provenance: Provenance | null;
  ledger: IntentLedger;
  tests: TestCheck;
  flags: Map<string, FileFlag[]>;
  scope?: Map<string, FileScope>;
  verdicts?: VerdictReport;
  claims?: ClaimReport;
  error: string | null;
}

const scopeCell = (s: FileScope | undefined) => {
  if (!s) return "-";
  const base = `${s.kind}: ${esc(s.reason)}`;
  return s.againstInstruction ? `${base}; you said: "${esc(s.againstInstruction.text)}" (prompt ${s.againstInstruction.prompt})` : base;
};
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);

export function renderSession(r: SessionReport): string {
  const s = r.session;
  const L: string[] = [];
  L.push(`# Session ${s.id.slice(0, 8)} (${s.startedAt.slice(0, 16).replace("T", " ")} UTC)`);
  L.push("");
  L.push(`<!-- offscript-spike session=${s.id} coverage=${r.provenance?.coverage ?? "null"} intents=${r.ledger.intents.length} -->`);
  L.push("");
  L.push(`- Repo: \`${r.repo}\`  Branch: \`${s.gitBranch ?? "?"}\`  Claude Code: ${s.cliVersion ?? "?"}`);
  L.push(
    `- Prompts: ${s.prompts.length}  Edits: ${s.edits.length}  Shell commands: ${s.shell.length}  Compactions: ${s.compactions}  Subagent transcripts: ${s.subagentFiles} (${s.edits.filter((e) => e.subagent).length} edits)  Files with Claude backups: ${s.backupFiles}  Secrets redacted: ${s.redactions}`,
  );
  const unknown = Object.entries(s.unknownRecordTypes);
  if (unknown.length) L.push(`- Unknown record types (parser warning): ${unknown.map(([k, v]) => `${k} x${v}`).join(", ")}`);
  L.push(`- Change reviewed: ${r.range ? r.range.label : "no commit or uncommitted change from this session found"}`);
  if (r.error) L.push(`- Error: ${r.error}`);
  L.push("");

  // Intents
  L.push(`## 1. What you asked for (intent ledger)`);
  L.push("");
  L.push(
    `Backend: ${r.ledger.backend}${r.ledger.costUsd !== null ? `, est. cost $${r.ledger.costUsd.toFixed(4)}` : ""}. Confidence: **${r.ledger.confidence}**.`,
  );
  if (r.ledger.error) L.push(`\n> Intent extraction failed: ${r.ledger.error}`);
  if (r.ledger.notes) L.push(`\nModel note: ${r.ledger.notes}`);
  L.push("");
  if (r.ledger.intents.length) {
    L.push(`| id | status | kind | intent | from prompt | quote |`);
    L.push(`|---|---|---|---|---|---|`);
    for (const i of r.ledger.intents) {
      const st = i.status === "active" ? "active" : `${i.status}${i.supersededBy ? ` by ${i.supersededBy}` : ""}`;
      L.push(`| ${i.id} | ${st} | ${i.kind} | ${esc(i.text)} | ${i.sourcePrompts.join(", ") || "-"} | ${esc(i.quote)} |`);
    }
  } else L.push(`_No intents extracted._`);
  L.push("");

  // Verdicts
  if (r.verdicts?.verdicts.length) {
    const v = r.verdicts;
    const order = [
      "done",
      "answered",
      "kept",
      "not checked",
      "partly done",
      "needs judgment",
      "not in change",
      "failed",
      "not done",
      "violated",
      "superseded",
      "cancelled",
    ];
    const summary = order.filter((k) => v.counts[k as keyof typeof v.counts]).map((k) => `${v.counts[k as keyof typeof v.counts]} ${k}`);
    L.push(`## 1b. Did it do what you asked? (verdicts from evidence, no model)`);
    L.push("");
    L.push(`${summary.join(" · ")}${v.extraFiles.length ? ` · plus ${v.extraFiles.length} file(s) changed that no request explains` : ""}`);
    L.push("");
    L.push(`| id | verdict | why | turns | files in change |`);
    L.push(`|---|---|---|---|---|`);
    const mark = (x: string) => (["not done", "failed", "violated", "not in change", "partly done"].includes(x) ? `**${x}**` : x);
    for (const x of v.verdicts) {
      const files = x.files.length
        ? `${x.files
            .slice(0, 4)
            .map((f) => `\`${esc(f)}\``)
            .join(", ")}${x.files.length > 4 ? ` +${x.files.length - 4}` : ""}`
        : "-";
      L.push(`| ${x.id} | ${mark(x.verdict)} | ${esc(x.why)} | ${x.turns.join(", ") || "-"} | ${files} |`);
    }
    if (v.extraFiles.length) L.push(`\nNot explained by any request: ${v.extraFiles.map((f) => `\`${esc(f)}\``).join(", ")}`);
    L.push("");
  }

  // Truth: claims the agent made, checked against what had happened before it made them
  if (r.claims && (r.claims.claims.length || r.claims.silentGaps.length)) {
    const c = r.claims;
    const order = ["contradicted", "stale", "overstated", "unsupported", "unverified", "verified"];
    L.push(`## 2a. Did it tell you the truth? (claims checked against evidence, no model)`);
    L.push("");
    L.push(
      order
        .filter((k) => c.counts[k as keyof typeof c.counts])
        .map((k) => `${c.counts[k as keyof typeof c.counts]} ${k}`)
        .join(" · ") || "no checkable claims",
    );
    L.push("");
    const shown = [...c.claims].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict));
    if (shown.length) {
      L.push(`| verdict | claim | after prompt | evidence |`);
      L.push(`|---|---|---|---|`);
      for (const x of shown.slice(0, 40)) {
        const v = ["contradicted", "stale", "overstated"].includes(x.verdict) ? `**${x.verdict}**` : x.verdict;
        L.push(`| ${v} | "${esc(x.sentence)}" (${x.kind}) | ${x.prompt} | ${esc(x.evidence.slice(0, 200))} |`);
      }
      if (shown.length > 40) L.push(`\n_${shown.length - 40} more claims not shown._`);
      L.push("");
    }
    if (c.silentGaps.length) {
      L.push(`**Silent gaps** (not finished, and the agent never said so):`);
      for (const g of c.silentGaps) L.push(`- ${esc(g.intent)}: ${g.verdict} (from prompt ${g.prompt})`);
      L.push("");
    }
  }

  // Claims
  L.push(`## 2. What the agent claimed vs evidence`);
  L.push("");
  L.push(
    `Tests: **${r.tests.evidence}** (${r.tests.testRuns} test run(s) in session${r.tests.lastTestCommand ? `, last: \`${esc(r.tests.lastTestCommand)}\`` : ""}).`,
  );
  L.push("");
  if (r.ledger.claims.length) {
    for (const c of r.ledger.claims) L.push(`- [${verdictForClaim(c, r.tests)}] "${esc(c.text)}" (${c.type})`);
  } else L.push(`_No completion claims found._`);
  L.push("");

  // Facts
  if (r.facts) {
    const f = r.facts;
    L.push(`## 3. Hard facts (no model)`);
    L.push("");
    L.push(`- ${f.filesChanged} files, +${f.linesAdded} / -${f.linesRemoved} lines`);
    if (f.added.length) L.push(`- Added: ${f.added.map((x) => `\`${x}\``).join(", ")}`);
    if (f.deleted.length) L.push(`- **Deleted:** ${f.deleted.map((x) => `\`${x}\``).join(", ")}`);
    if (f.renamed.length) L.push(`- Renamed: ${f.renamed.map((x) => `\`${x.from}\` -> \`${x.to}\``).join(", ")}`);
    if (f.removedSymbols.length)
      L.push(
        `- **Removed symbols:** ${f.removedSymbols
          .slice(0, 20)
          .map((x) => `\`${x.symbol}\` (${x.file})`)
          .join(", ")}`,
      );
    if (f.dependencyFiles.length) L.push(`- Dependency files: ${f.dependencyFiles.map((x) => `\`${x}\``).join(", ")}`);
    if (f.sensitiveFiles.length) L.push(`- **Sensitive paths:** ${f.sensitiveFiles.map((x) => `\`${x}\``).join(", ")}`);
    const ti = f.testIntegrity;
    if (f.testFiles.length) {
      L.push(`- Test files changed: ${f.testFiles.length}; assertions +${ti.assertionsAdded} / -${ti.assertionsRemoved}`);
    }
    if (ti.skipsAdded.length)
      L.push(
        `- **Skip/only added:** ${ti.skipsAdded
          .slice(0, 10)
          .map((x) => `${x.file}: \`${esc(x.line)}\``)
          .join("; ")}`,
      );
    if (ti.testFilesDeleted.length) L.push(`- **Test files deleted:** ${ti.testFilesDeleted.join(", ")}`);
    if (ti.assertionsRemoved > ti.assertionsAdded) L.push(`- **Net assertions went down by ${ti.assertionsRemoved - ti.assertionsAdded}.**`);
    L.push("");
  }

  // Provenance
  if (r.provenance) {
    const p = r.provenance;
    L.push(`## 4. Which turn wrote what (provenance)`);
    L.push("");
    const own = p.totalAddedLines - p.otherSessionLines;
    L.push(`Traced **${p.attributedLines} of ${own}** added lines to an edit in this session: **${pct(p.coverage)}**.`);
    if (p.viaBackups) {
      L.push(
        `Of those, ${p.viaBackups} line(s) were found only through Claude Code's own file backups: written in this session, but not with an edit tool (for example a script run through Bash).`,
      );
    }
    if (p.otherSessionLines) {
      L.push(
        `Another ${p.otherSessionLines} added line(s) in these files were written by other sessions (${p.otherSessions.map((x) => `\`${x.slice(0, 8)}\``).join(", ")}), so they are not counted for or against this one.`,
      );
    }
    if (p.editsOutsideRepo) L.push(`Edits outside this repo in the session: ${p.editsOutsideRepo}.`);
    if (p.agentFilesNotInDiff.length)
      L.push(
        `Agent edited but nothing left in this diff: ${p.agentFilesNotInDiff
          .slice(0, 15)
          .map((x) => `\`${x}\``)
          .join(", ")}`,
      );
    L.push("");
    L.push(`| file | status | +lines | traced | other sessions | written in turn(s) | scope | agent mentioned it | flags |`);
    L.push(`|---|---|---|---|---|---|---|---|---|`);
    const scratch = p.files.filter((f) => r.scope?.get(f.path)?.kind === "scratch");
    if (scratch.length) {
      const dirs = [...new Set(scratch.map((f) => f.path.split("/").slice(0, -1).join("/") || "."))];
      L.push(
        `The agent left ${scratch.length} scratch file(s) in ${dirs.map((d) => `\`${d}/\``).join(", ")}: helper scripts and notes, not part of the change. Delete them or add the folder to .gitignore.`,
      );
      L.push("");
    }
    const rows = [...p.files].sort((a, b) => (r.flags.get(b.path)?.length ?? 0) - (r.flags.get(a.path)?.length ?? 0));
    for (const f of rows.slice(0, 60)) {
      const flags = r.flags.get(f.path) ?? [];
      L.push(
        `| \`${esc(f.path)}\` | ${f.status} | ${f.addedLines} | ${f.addedLines - f.otherSessionLines ? pct(f.attributedLines / (f.addedLines - f.otherSessionLines)) : "-"} | ${f.otherSessionLines || "-"} | ${f.turns.join(", ") || "-"} | ${scopeCell(r.scope?.get(f.path))} | ${f.inAgentText ? "yes" : "no"} | ${flags.map((x) => (x === "undisclosed" || x === "against-instruction" ? `**${x}**` : x)).join(", ")} |`,
      );
    }
    if (rows.length > 60) L.push(`\n_${rows.length - 60} more files not shown._`);
    L.push("");
  }

  // Prompts for labelling
  L.push(`## 5. Your prompts (redacted, for labelling)`);
  L.push("");
  for (const pr of s.prompts.slice(0, 40)) {
    const t = pr.text.replace(/\s+/g, " ");
    L.push(`- **[${pr.index}]** ${esc(t.length > 300 ? `${t.slice(0, 300)}...` : t)}`);
  }
  if (s.prompts.length > 40) L.push(`- _${s.prompts.length - 40} more prompts not shown._`);
  L.push("");

  L.push(`## 6. Your labels (fill these in, then run \`bun run spike:score\`)`);
  L.push("");
  L.push("- intents_correct (y/n): ");
  L.push("- intents_missed (number): ");
  L.push("- intents_invented (number): ");
  L.push("- provenance_right (y/n): ");
  L.push("- flags_useful (y/n): ");
  L.push("- notes: ");
  L.push("");
  return L.join("\n");
}
