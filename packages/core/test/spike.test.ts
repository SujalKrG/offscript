import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTests, fileFlags, verdictForClaim } from "../src/checks.ts";
import { extractFacts } from "../src/facts.ts";
import { makeRelResolver, repoRoot, sessionChange, worktreeRoots } from "../src/git.ts";
import { findSessions, parseSession, TEST_COMMAND_RE, userCommandFailed } from "../src/ingest/claude-code.ts";
import { buildIntentLedger } from "../src/intent.ts";
import { buildOtherSessionIndex, traceProvenance } from "../src/provenance.ts";
import { redact } from "../src/redact.ts";
import { renderSession } from "../src/report.ts";
import { classifyScope, pathWords } from "../src/scope.ts";
import { intentWindows, judgeIntents } from "../src/verdicts.ts";
import { buildFixture, fakeClaude } from "./fixture.ts";

const fx = buildFixture();
const root = repoRoot(fx.repo)!;

describe("ingest", () => {
  test("finds the session by cwd", () => {
    const refs = findSessions(root, fx.projects);
    expect(refs.map((r) => r.id)).toEqual([fx.sessionId]);
  });

  test("parses prompts, edits, shell runs; skips meta; redacts; counts unknown types", () => {
    const s = parseSession(fx.transcript);
    expect(s.prompts.length).toBe(2);
    expect(s.prompts[0]!.text).not.toContain("FAKEFAKEFAKE");
    expect(s.prompts[0]!.text).toContain("[REDACTED:anthropic-key]");
    expect(s.redactions).toBe(1);
    expect(s.edits.map((e) => e.tool)).toEqual(["Edit", "Write", "Edit", "Edit"]);
    expect(s.edits[1]!.kind).toBe("create");
    expect(s.edits[0]!.addedLines).toContain("  return sum - discount;");
    expect(s.shell.map((x) => x.failed)).toEqual([true, false]);
    expect(s.shell.every((x) => x.isTest)).toBe(true);
    expect(s.unknownRecordTypes["weird-new-type"]).toBe(1);
    expect(s.edits[2]!.afterPrompt).toBe(2);
  });
});

const gitc = (cwd: string, ...args: string[]) => {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

describe("facts + provenance + checks", () => {
  const s = parseSession(fx.transcript);
  const change = sessionChange(root, s)!;
  const files = change.files;
  const facts = extractFacts(files);
  const prov = traceProvenance(root, s, files, change.roots);

  test("uncommitted change is limited to the files this session edited", () => {
    expect(change.commits).toEqual([]);
    expect(files.map((f) => f.path).sort()).toEqual(["src/auth/session.ts", "src/cart.ts", "src/coupon.ts", "tests/cart.test.ts"]);
    expect(change.label).toContain("uncommitted edits in 4");
  });

  test("hard facts", () => {
    expect(facts.added).toEqual(["src/coupon.ts"]);
    expect(facts.sensitiveFiles).toContain("src/auth/session.ts");
    expect(facts.removedSymbols.map((x) => x.symbol)).toContain("legacyTotal");
    expect(facts.removedSymbols.map((x) => x.symbol)).not.toContain("total");
    expect(facts.testIntegrity.skipsAdded.length).toBe(1);
    expect(facts.testIntegrity.assertionsRemoved).toBeGreaterThan(facts.testIntegrity.assertionsAdded);
  });

  test("provenance traces agent lines and leaves the human line untraced", () => {
    const byPath = new Map(prov.files.map((f) => [f.path, f]));
    expect(byPath.get("src/cart.ts")!.attributedLines).toBe(byPath.get("src/cart.ts")!.addedLines);
    expect(byPath.get("src/cart.ts")!.turns).toEqual([1]);
    expect(byPath.get("tests/cart.test.ts")!.turns).toEqual([2]);
    const coupon = byPath.get("src/coupon.ts")!;
    expect(coupon.attributedLines).toBe(coupon.addedLines - 1);
    expect(prov.coverage).toBeGreaterThan(0.8);
    expect(prov.coverage).toBeLessThan(1);
  });

  test("flags: auth edit goes against 'Don't touch auth', is undisclosed and sensitive; the test for cart.ts is not flagged", () => {
    const scope = classifyScope({ provenance: prov, prompts: s.prompts, roots: [root] });
    const flags = fileFlags(prov, facts, scope);
    expect(flags.get("src/auth/session.ts")).toEqual(expect.arrayContaining(["against-instruction", "undisclosed", "sensitive"]));
    expect(scope.get("src/auth/session.ts")!.againstInstruction!.prompt).toBe(1);
    expect(flags.get("src/coupon.ts")).not.toContain("undisclosed");
    expect(scope.get("tests/cart.test.ts")!.kind).toBe("anchor"); // "cart" is in your prompt
    expect(flags.get("tests/cart.test.ts")).not.toContain("undisclosed");
  });

  test("test evidence: passed after last edit verifies a tests_pass claim", () => {
    const t = checkTests(s, root);
    expect(t.evidence).toBe("passed-after-last-edit");
    expect(verdictForClaim({ text: "All tests pass", type: "tests_pass" }, t)).toBe("verified");
  });
});

describe("session change from commits", () => {
  test("finds the session's commit on another branch (not checked out)", () => {
    const f = buildFixture();
    const r = repoRoot(f.repo)!;
    gitc(r, "checkout", "-q", "-b", "feat/discount");
    gitc(r, "add", "src/cart.ts", "src/coupon.ts", "src/auth/session.ts", "tests/cart.test.ts");
    gitc(r, "commit", "-q", "-m", "agent work");
    gitc(r, "checkout", "-q", "-");
    const s = parseSession(f.transcript);
    const c = sessionChange(r, s)!;
    expect(c.commits.length).toBe(1);
    expect(c.uncommittedFiles).toEqual([]);
    const prov = traceProvenance(r, s, c.files, c.roots);
    expect(prov.files.find((x) => x.path === "src/cart.ts")!.turns).toEqual([1]);
  });

  test("ignores a parallel session's commit that touches none of this session's files", () => {
    const f = buildFixture();
    const r = repoRoot(f.repo)!;
    gitc(r, "add", "README.md");
    gitc(r, "commit", "-q", "-m", "someone else's work");
    gitc(r, "add", "-A");
    gitc(r, "commit", "-q", "-m", "agent work");
    const c = sessionChange(r, parseSession(f.transcript))!;
    expect(c.commits.length).toBe(1);
    expect(c.files.map((x) => x.path)).not.toContain("README.md");
  });
});

describe("shared commits", () => {
  test("a commit that also carries another session's files only contributes this session's files", () => {
    const f = buildFixture();
    const r = repoRoot(f.repo)!;
    gitc(r, "add", "-A"); // README.md (human, not in the session) rides along in the same commit
    gitc(r, "commit", "-q", "-m", "mixed commit");
    const s = parseSession(f.transcript);
    const c = sessionChange(r, s)!;
    expect(c.commits.length).toBe(1);
    expect(c.files.map((x) => x.path)).not.toContain("README.md");
    expect(c.label).toContain("1 other file(s) in those commits left out");
    expect(traceProvenance(r, s, c.files, c.roots).coverage).toBeGreaterThan(0.8);
  });
});

describe("parallel sessions", () => {
  test("a line another session wrote is credited to it, not counted as untraced", () => {
    const s = parseSession(fx.transcript);
    const files = sessionChange(root, s)!.files;
    const before = traceProvenance(root, s, files);
    const other = { ...s, id: "other-session-0001", edits: [{ ...s.edits[1]!, addedLines: ["export const COUPON_NOTE = 'added by a human';"] }] };
    const idx = buildOtherSessionIndex(root, [other]);
    const after = traceProvenance(root, s, files, [root], idx);
    expect(before.coverage).toBeLessThan(1);
    expect(after.otherSessionLines).toBe(1);
    expect(after.otherSessions).toEqual(["other-session-0001"]);
    expect(after.coverage).toBe(1);
    expect(after.attributedLines).toBe(before.attributedLines);
  });

  test("this session's own lines are never credited elsewhere", () => {
    const s = parseSession(fx.transcript);
    const files = sessionChange(root, s)!.files;
    const idx = buildOtherSessionIndex(root, [{ ...s, id: "copycat" }]);
    const p = traceProvenance(root, s, files, [root], idx);
    expect(p.attributedLines).toBe(traceProvenance(root, s, files).attributedLines);
    expect(p.otherSessionLines).toBe(0);
  });
});

describe("subagents", () => {
  test("edits made by a Task-tool subagent are merged into the session", () => {
    const f = buildFixture({ subagent: true });
    const r = repoRoot(f.repo)!;
    const s = parseSession(f.transcript);
    expect(s.subagentFiles).toBe(1);
    expect(s.prompts.length).toBe(2); // the subagent's task prompt is not a human prompt
    const sub = s.edits.find((e) => e.subagent)!;
    expect(sub.subagent).toBe("agent-a1b2c3");
    expect(sub.afterPrompt).toBe(2);
    expect(s.shell[s.shell.length - 1]!.seq).toBeGreaterThan(sub.seq); // order kept by time
    const c = sessionChange(r, s)!;
    expect(traceProvenance(r, s, c.files, c.roots).coverage).toBe(1);
  });
});

describe("Claude Code file backups", () => {
  test("a line written by a Bash script is traced through the backups, to the right turn", () => {
    const f = buildFixture({ backups: true });
    const r = repoRoot(f.repo)!;
    const s = parseSession(f.transcript);
    expect(s.backupFiles).toBe(1);
    expect(s.turnDeltas.length).toBe(1);
    expect(s.turnDeltas[0]!.afterPrompt).toBe(1);
    expect(s.turnDeltas[0]!.addedLines).toContain("export const COUPON_NOTE = 'added by a human';");
    const c = sessionChange(r, s)!;
    const p = traceProvenance(r, s, c.files, c.roots);
    expect(p.coverage).toBe(1);
    expect(p.viaBackups).toBe(1);
    expect(p.files.find((x) => x.path === "src/coupon.ts")!.turns).toEqual([1]);
    expect(checkTests(s, r).evidence).toBe("passed-after-last-edit"); // backups never move the last-edit marker
  });

  test("uncommitted files are compared with the pre-session backup, so earlier local changes are not counted", () => {
    const { appendFileSync, mkdirSync: mk, writeFileSync: wf, readFileSync: rf } = require("node:fs") as typeof import("node:fs");
    const { dirname: dn } = require("node:path") as typeof import("node:path");
    const f = buildFixture();
    const r = repoRoot(f.repo)!;
    // Before the session, the file already had an uncommitted local line. Claude backed that state up as v1.
    const before =
      "// local experiment, not from this session\nexport function total(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n\nexport function legacyTotal(x: number[]) {\n  return x.length;\n}\n";
    const fh = join(dn(dn(dn(f.transcript))), "file-history", f.sessionId);
    mk(fh, { recursive: true });
    wf(join(fh, "cafe000000000001@v1"), before);
    appendFileSync(
      f.transcript,
      `${JSON.stringify({
        type: "file-history-delta",
        messageId: "x",
        trackingPath: "src/cart.ts",
        backup: { backupFileName: "cafe000000000001@v1", version: 1, backupTime: "2000-01-01T00:00:00.000Z", realParentDir: join(f.repo, "src") },
      })}\n`,
    );
    const cart = join(f.repo, "src", "cart.ts");
    wf(cart, `// local experiment, not from this session\n${rf(cart, "utf8")}`);
    const s = parseSession(f.transcript);
    expect(s.baselines.length).toBe(1);
    const c = sessionChange(r, s)!;
    expect(c.label).toContain("compared with Claude's backup");
    const added = c.files.find((x) => x.path === "src/cart.ts")!.added.map((l) => l.text);
    expect(added).not.toContain("// local experiment, not from this session");
    expect(added).toContain("  return sum - discount;");
  });

  test("without backups on disk nothing changes", () => {
    const s = parseSession(fx.transcript);
    expect(s.turnDeltas).toEqual([]);
    expect(s.backupFiles).toBe(0);
  });
});

describe("double counting", () => {
  test("uncommitted content identical to a picked commit is counted once", () => {
    const f = buildFixture();
    const r = repoRoot(f.repo)!;
    gitc(r, "checkout", "-q", "-b", "feat/x");
    gitc(r, "add", "src/cart.ts", "src/coupon.ts", "src/auth/session.ts", "tests/cart.test.ts");
    gitc(r, "commit", "-q", "-m", "agent work");
    gitc(r, "checkout", "-q", "-");
    gitc(r, "checkout", "feat/x", "--", "src/cart.ts"); // same content carried into the other checkout
    gitc(r, "reset", "-q", "src/cart.ts");
    const s = parseSession(f.transcript);
    const c = sessionChange(r, s)!;
    expect(c.uncommittedFiles).toContain("src/cart.ts");
    const cart = c.files.find((x) => x.path === "src/cart.ts")!;
    expect(cart.added.length).toBe(3);
  });
});

describe("code review fixes", () => {
  const fs = require("node:fs") as typeof import("node:fs");

  /** Minimal transcript + backups: v1 at +10 min, v2 at +60 min, optional shell command at +30 min. */
  function backupOnlySession(command: string | null) {
    const base = mkdtempSync(join(tmpdir(), "offscript-gate-"));
    const id = "11111111-2222-4333-8444-555555555555";
    const proj = join(base, "claude", "projects", "p");
    const fh = join(base, "claude", "file-history", id);
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(fh, { recursive: true });
    fs.writeFileSync(join(fh, "f00d@v1"), "a\n");
    fs.writeFileSync(join(fh, "f00d@v2"), "a\nb written later\n");
    const T = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min)).toISOString();
    const file = join(base, "repo", "f.ts");
    const recs: unknown[] = [
      { type: "user", sessionId: id, cwd: join(base, "repo"), timestamp: T(0), origin: { kind: "human" }, message: { role: "user", content: "go" } },
      {
        type: "file-history-delta",
        trackingPath: "f.ts",
        backup: { backupFileName: "f00d@v1", version: 1, backupTime: T(10), realParentDir: join(base, "repo") },
        timestamp: T(10),
      },
    ];
    if (command) {
      recs.push({
        type: "assistant",
        sessionId: id,
        timestamp: T(30),
        message: { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command } }] },
      });
      recs.push({
        type: "user",
        sessionId: id,
        timestamp: T(30),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "" }] },
      });
    }
    recs.push({ type: "user", sessionId: id, timestamp: T(60), origin: { kind: "human" }, message: { role: "user", content: "next" } });
    recs.push({
      type: "file-history-snapshot",
      snapshot: {
        timestamp: T(60),
        trackedFileBackups: { "f.ts": { backupFileName: "f00d@v2", version: 2, backupTime: T(60), realParentDir: join(base, "repo") } },
      },
      timestamp: T(60),
    });
    const t = join(proj, `${id}.jsonl`);
    fs.writeFileSync(t, `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
    return { s: parseSession(t), file };
  }

  test("#1 a backup change with no agent activity in that window is not credited to the agent", () => {
    const idle = backupOnlySession(null);
    expect(idle.s.turnDeltas).toEqual([]);
    expect(idle.s.backupLinesUnexplained).toBe(1);
    const readOnly = backupOnlySession("git status && ls");
    expect(readOnly.s.turnDeltas).toEqual([]);
    const script = backupOnlySession("python fix.py");
    expect(script.s.turnDeltas.length).toBe(1);
    expect(script.s.turnDeltas[0]!.addedLines).toEqual(["b written later"]);
  });

  test("#1 a backup-only line that another session wrote with an edit tool is credited to that session", () => {
    const f = buildFixture({ backups: true });
    const r = repoRoot(f.repo)!;
    const s = parseSession(f.transcript);
    const c = sessionChange(r, s)!;
    const other = { ...s, id: "other-0001", turnDeltas: [], edits: [{ ...s.edits[1]!, addedLines: ["export const COUPON_NOTE = 'added by a human';"] }] };
    const p = traceProvenance(r, s, c.files, c.roots, buildOtherSessionIndex(r, [other]));
    expect(p.viaBackups).toBe(0);
    expect(p.otherSessionLines).toBe(1);
  });

  test("#2 a cherry-picked copy of the same commit is counted once", () => {
    const f = buildFixture();
    const r = repoRoot(f.repo)!;
    gitc(r, "checkout", "-q", "-b", "feat/a");
    gitc(r, "add", "src/cart.ts");
    gitc(r, "commit", "-q", "-m", "work");
    gitc(r, "checkout", "-q", "-b", "feat/b", "HEAD~1");
    gitc(r, "add", "README.md");
    gitc(r, "commit", "-q", "-m", "unrelated");
    gitc(r, "cherry-pick", "feat/a"); // same change, different parent: a different sha, the same patch-id
    const c = sessionChange(r, parseSession(f.transcript))!;
    expect(c.commits.length).toBe(1);
    expect(c.label).toContain("1 duplicate copy skipped");
    expect(c.files.find((x) => x.path === "src/cart.ts")!.added.filter((l) => l.text.includes("return sum - discount")).length).toBe(1);
  });

  test("#2 a line added and then rewritten in a later commit nets out", () => {
    const f = buildFixture();
    const r = repoRoot(f.repo)!;
    gitc(r, "add", "src/cart.ts");
    gitc(r, "commit", "-q", "-m", "first");
    const cart = join(f.repo, "src", "cart.ts");
    fs.writeFileSync(cart, fs.readFileSync(cart, "utf8").replace("  return sum - discount;", "  return Math.max(0, sum - discount);"));
    gitc(r, "add", "src/cart.ts");
    gitc(r, "commit", "-q", "-m", "second");
    const c = sessionChange(r, parseSession(f.transcript))!;
    const cartDiff = c.files.find((x) => x.path === "src/cart.ts")!;
    expect(cartDiff.added.map((l) => l.text)).not.toContain("  return sum - discount;");
    expect(cartDiff.added.map((l) => l.text)).toContain("  return Math.max(0, sum - discount);");
    expect(cartDiff.removed.map((l) => l.text)).not.toContain("  return sum - discount;");
  });

  test("#3 a manual --base with no --head includes untracked files", () => {
    const c = sessionChange(root, parseSession(fx.transcript), { base: "HEAD" })!;
    expect(c.files.map((x) => x.path)).toContain("src/coupon.ts");
  });

  test("#4 repeated lines are not collapsed when uncommitted edits overlap a commit", () => {
    const f = buildFixture();
    const r = repoRoot(f.repo)!;
    gitc(r, "checkout", "-q", "-b", "feat/x");
    gitc(r, "add", "src/cart.ts");
    gitc(r, "commit", "-q", "-m", "agent work");
    gitc(r, "checkout", "-q", "-");
    const cart = join(f.repo, "src", "cart.ts");
    gitc(r, "checkout", "feat/x", "--", "src/cart.ts");
    gitc(r, "reset", "-q", "src/cart.ts");
    // The working copy repeats a line the commit already added once: one occurrence is the commit's, one is new.
    fs.appendFileSync(cart, "export function net(sum: number, discount = 0) {\n  return sum - discount;\n}\n");
    const c = sessionChange(r, parseSession(f.transcript))!;
    const added = c.files.find((x) => x.path === "src/cart.ts")!.added.map((l) => l.text.trim());
    expect(added.filter((t) => t === "return sum - discount;").length).toBe(2);
  });

  test("#5 a file back to its pre-session state is not counted as an uncommitted edit", () => {
    const f = buildFixture();
    const r = repoRoot(f.repo)!;
    const cart = join(f.repo, "src", "cart.ts");
    const fh = join(join(f.transcript, "..", "..", ".."), "file-history", f.sessionId);
    fs.mkdirSync(fh, { recursive: true });
    fs.writeFileSync(join(fh, "beef@v1"), fs.readFileSync(cart, "utf8"));
    fs.appendFileSync(
      f.transcript,
      `${JSON.stringify({
        type: "file-history-delta",
        trackingPath: "src/cart.ts",
        backup: { backupFileName: "beef@v1", version: 1, backupTime: "2000-01-01T00:00:00.000Z", realParentDir: join(f.repo, "src") },
      })}\n`,
    );
    const c = sessionChange(r, parseSession(f.transcript))!;
    expect(c.uncommittedFiles).not.toContain("src/cart.ts");
    expect(c.files.map((x) => x.path)).not.toContain("src/cart.ts");
    expect(c.label).toContain("uncommitted edits in 3 of its files");
  });

  test("#6 merged subagent events keep a total order even without timestamps", () => {
    const s = parseSession(buildFixture({ subagent: true }).transcript);
    const seqs = [...s.edits, ...s.shell].map((e) => e.seq).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe("scope (what was asked for vs drift)", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const fp = (path: string, o: Partial<import("../src/provenance.ts").FileProvenance> = {}) => ({
    path,
    status: "modified" as const,
    addedLines: 5,
    attributedLines: 5,
    otherSessionLines: 0,
    viaBackups: 0,
    turns: [1],
    touchedByAgent: true,
    shellMentioned: false,
    inPrompts: false,
    inAgentText: false,
    ...o,
  });
  const prov = (files: ReturnType<typeof fp>[]) =>
    ({
      files,
      totalAddedLines: 0,
      attributedLines: 0,
      otherSessionLines: 0,
      viaBackups: 0,
      otherSessions: [],
      coverage: 1,
      editsOutsideRepo: 0,
      agentFilesNotInDiff: [],
    }) as import("../src/provenance.ts").Provenance;

  test("path words drop generic segments and fold plurals", () => {
    expect(pathWords("apps/driver-mobile/src/features/payments/AddMoneyCard.tsx")).toEqual(["driver", "payment", "money", "card"]);
  });

  test("a feature folder named by your request is in scope, with its siblings and tests (no undisclosed noise)", () => {
    const p = prov([
      fp("apps/driver/src/features/payments/api.ts"),
      fp("apps/driver/src/features/payments/AddMoneyCard.tsx"),
      fp("apps/driver/src/features/payments/paymentMachine.ts"),
      fp("apps/driver/src/features/payments/paymentMachine.test.ts"),
    ]);
    const scope = classifyScope({ provenance: p, prompts: [{ index: 1, text: "we will be using payu as the payment gateway, integrate their sdk" }] });
    for (const f of p.files) expect(scope.get(f.path)!.kind).not.toBe("drift");
    expect(scope.get("apps/driver/src/features/payments/paymentMachine.test.ts")!.kind).toMatch(/anchor|related/);
  });

  test("an import one hop away from what you asked for is related, including @/ aliases", () => {
    const repo = mkdtempSync(join(tmpdir(), "offscript-scope-"));
    for (const d of ["api/src/modules/rides", "api/src/lib", "api/src/modules/pricing"]) fs.mkdirSync(join(repo, d), { recursive: true });
    fs.writeFileSync(join(repo, "api/src/modules/rides/rides.service.ts"), "import { hashOtp } from '@/lib/otp';\nimport { fare } from '../pricing/fare';\n");
    fs.writeFileSync(join(repo, "api/src/lib/otp.ts"), "export const hashOtp = () => 1;\n");
    fs.writeFileSync(join(repo, "api/src/modules/pricing/fare.ts"), "export const fare = 1;\n");
    const p = prov([fp("api/src/modules/rides/rides.service.ts", { inPrompts: true }), fp("api/src/lib/otp.ts"), fp("api/src/modules/pricing/fare.ts")]);
    const scope = classifyScope({
      provenance: p,
      prompts: [{ index: 1, text: "in rides.service.ts the trip end pin is sometimes not generated" }],
      roots: [repo],
    });
    expect(scope.get("api/src/modules/rides/rides.service.ts")!.kind).toBe("anchor");
    expect(scope.get("api/src/lib/otp.ts")).toMatchObject({ kind: "related", reason: "imported by api/src/modules/rides/rides.service.ts" });
    expect(scope.get("api/src/modules/pricing/fare.ts")).toMatchObject({ kind: "related", reason: "imported by api/src/modules/rides/rides.service.ts" });
  });

  test("a word that is everywhere in the repo (an app name) does not anchor files on its own", () => {
    const repoPaths = [
      ...Array.from({ length: 30 }, (_, i) => `apps/driver-mobile/src/screen${i}.tsx`),
      ...Array.from({ length: 70 }, (_, i) => `api/src/x${i}.ts`),
    ];
    const p = prov([fp("apps/driver-mobile/src/features/payments/api.ts"), fp("apps/driver-mobile/src/legal/Terms.tsx")]);
    const scope = classifyScope({ provenance: p, prompts: [{ index: 1, text: "driver app: switch the payment gateway to payu" }], repoPaths });
    expect(scope.get("apps/driver-mobile/src/features/payments/api.ts")!.kind).toBe("anchor"); // "payment" is rare
    expect(scope.get("apps/driver-mobile/src/legal/Terms.tsx")!.kind).toBe("drift"); // only "driver" matched
  });

  test("a sensitive file is not in scope just because it sits next to one that is", () => {
    const p = prov([fp("infra/terraform/github-oidc.tf", { inAgentText: true }), fp("infra/terraform/ssm-observability.tf")]);
    const scope = classifyScope({ provenance: p, prompts: [{ index: 1, text: "set up the S3 log archive" }] });
    expect(scope.get("infra/terraform/ssm-observability.tf")!.kind).toBe("drift");
    expect(fileFlags(p, extractFacts([]), scope).get("infra/terraform/ssm-observability.tf")).toContain("undisclosed");
  });

  test("helper scripts in a scratch folder are grouped as scratch, not flagged one by one as undisclosed", () => {
    const p = prov([fp(".scratch/patch1.py"), fp(".scratch/qperf/chunk1.ts"), fp("api/src/x.ts")]);
    const scope = classifyScope({ provenance: p, prompts: [{ index: 1, text: "tune the autoscaling" }] });
    expect(scope.get(".scratch/patch1.py")!.kind).toBe("scratch");
    const flags = fileFlags(p, extractFacts([]), scope);
    expect(flags.get(".scratch/qperf/chunk1.ts")).toEqual(["scratch-file"]);
  });

  test("lockfiles, .gitignore and generated files are derived, never undisclosed", () => {
    const p = prov([fp("load-tests/k6/.gitignore"), fp("bun.lock"), fp("apps/web/__generated__/graphql.ts")]);
    const scope = classifyScope({ provenance: p, prompts: [{ index: 1, text: "prepare the lifecycle load test script" }] });
    for (const f of p.files) expect(scope.get(f.path)!.kind).toBe("derived");
  });

  test("an unrelated file nobody asked for or mentioned is drift and flagged undisclosed", () => {
    const p = prov([fp("apps/web/src/checkout/Cart.tsx"), fp("api/src/jobs/workers/notifications.worker.ts")]);
    const scope = classifyScope({ provenance: p, prompts: [{ index: 1, text: "fix the cart total rounding" }] });
    expect(scope.get("apps/web/src/checkout/Cart.tsx")!.kind).toBe("anchor");
    expect(scope.get("api/src/jobs/workers/notifications.worker.ts")!.kind).toBe("drift");
    const facts = extractFacts([]);
    expect(fileFlags(p, facts, scope).get("api/src/jobs/workers/notifications.worker.ts")).toContain("undisclosed");
  });

  test("a file the agent told you about is not flagged, even if you did not ask for it", () => {
    const p = prov([fp("api/src/jobs/workers/notifications.worker.ts", { inAgentText: true })]);
    const scope = classifyScope({ provenance: p, prompts: [{ index: 1, text: "fix the cart total rounding" }] });
    expect(scope.get("api/src/jobs/workers/notifications.worker.ts")).toMatchObject({ kind: "related", reason: "the agent told you about it" });
  });

  test("changing something you said not to touch is flagged against-instruction, even when the agent mentioned it", () => {
    const p = prov([fp("api/src/payments/webhook.ts", { inAgentText: true }), fp("api/src/cart/total.ts")]);
    const scope = classifyScope({
      provenance: p,
      prompts: [{ index: 2, text: "Fix the cart total rounding. Don't touch the payments code, it's live." }],
    });
    expect(scope.get("api/src/payments/webhook.ts")!.againstInstruction).toMatchObject({ prompt: 2 });
    expect(scope.get("api/src/cart/total.ts")!.againstInstruction).toBeNull();
    expect(fileFlags(p, extractFacts([]), scope).get("api/src/payments/webhook.ts")).toContain("against-instruction");
  });

  test("questions with 'not' are not prohibitions; real ones are", () => {
    const p = prov([fp("api/src/payments/page.ts", { inAgentText: true })]);
    for (const text of ["why is the payment page not changing?", "the payment page is not working, fix it"]) {
      expect(classifyScope({ provenance: p, prompts: [{ index: 1, text }] }).get("api/src/payments/page.ts")!.againstInstruction).toBeNull();
    }
    for (const text of ["leave payments alone", "never modify the payment code", "keep payments as is"]) {
      expect(classifyScope({ provenance: p, prompts: [{ index: 1, text }] }).get("api/src/payments/page.ts")!.againstInstruction).not.toBeNull();
    }
  });

  test("words from a positive request win over the same word in a 'don't' sentence elsewhere", () => {
    const p = prov([fp("api/src/payments/refund.ts")]);
    const scope = classifyScope({
      provenance: p,
      prompts: [
        { index: 1, text: "add partial refunds to payments" },
        { index: 2, text: "don't touch payments config in prod" },
      ],
    });
    expect(scope.get("api/src/payments/refund.ts")!.kind).toBe("anchor");
  });
});

describe("verdicts (did it do what you asked?)", () => {
  type I = import("../src/types.ts").Intent;
  const intent = (id: string, text: string, sourcePrompts: number[], o: Partial<I> = {}): I => ({
    id,
    text,
    kind: "task",
    sourcePrompts,
    quote: "",
    status: "active",
    supersededBy: null,
    ...o,
  });

  test("end to end on the fixture: code landed, constraint violated, test run verified", () => {
    const s = parseSession(fx.transcript);
    const change = sessionChange(root, s)!;
    const prov = traceProvenance(root, s, change.files, change.roots);
    const scope = classifyScope({ provenance: prov, prompts: s.prompts, roots: [root] });
    const r = judgeIntents(
      s,
      [
        intent("I1", "Add a discount parameter to total() and a coupon helper", [1]),
        intent("C1", "Do not touch auth", [1], { kind: "constraint" }),
        intent("I2", "Fix the failing tests and run the tests again", [2]),
      ],
      prov,
      scope,
    );
    const by = new Map(r.verdicts.map((v) => [v.id, v]));
    expect(by.get("I1")!.verdict).toBe("done");
    expect(by.get("I1")!.files).toEqual(expect.arrayContaining(["src/cart.ts", "src/coupon.ts"]));
    expect(by.get("C1")!.verdict).toBe("violated");
    expect(by.get("C1")!.files).toEqual(["src/auth/session.ts"]);
    expect(by.get("I2")!.verdict).toBe("done");
    expect(by.get("I2")!.actions).toEqual([expect.objectContaining({ kind: "tests", status: "ok" })]);
    expect(r.extraFiles).toContain("src/auth/session.ts");
  });

  // A small hand-built session for the action verdicts.
  const session = (shell: { p: number; cmd: string; failed?: boolean }[], assistant: { p: number; text: string }[] = [], prompts = 4) =>
    ({
      ...parseSession(fx.transcript),
      prompts: Array.from({ length: prompts }, (_, i) => ({ index: i + 1, uuid: "", timestamp: "", text: "" })),
      edits: [],
      turnDeltas: [],
      shell: shell.map((x, i) => ({ seq: i + 1, afterPrompt: x.p, toolUseId: "", command: x.cmd, isTest: /\btest\b/.test(x.cmd), failed: x.failed ?? false })),
      assistant: assistant.map((a) => ({ afterPrompt: a.p, uuid: "", timestamp: "", text: a.text })),
    }) as import("../src/types.ts").Session;

  test("follow-up prompts like 'merge' belong to the request before them", () => {
    const w = intentWindows([intent("I1", "commit and open a PR", [1]), intent("I2", "fix the footer", [3])], 4);
    expect(w.get("I1")).toEqual([1, 2]);
    expect(w.get("I2")).toEqual([3, 4]);
  });

  test("commit ran but no PR was opened: partly done, and says what is missing", () => {
    const r = judgeIntents(
      session([{ p: 1, cmd: "git add -A && git commit -m x" }]),
      [intent("I1", "Commit the fix and open a PR to develop", [1])],
      null,
      null,
    );
    expect(r.verdicts[0]).toMatchObject({ verdict: "partly done" });
    expect(r.verdicts[0]!.why).toContain("no sign of: pr");
  });

  test("everything asked ran and succeeded: done", () => {
    const r = judgeIntents(
      session([
        { p: 1, cmd: "git commit -m x" },
        { p: 1, cmd: "git push -u origin fix/x" },
        { p: 2, cmd: "gh pr create --base develop" },
        { p: 2, cmd: "gh pr merge 42 --squash" },
      ]),
      [intent("I1", "Commit, push, open a PR to develop and merge it", [1])],
      null,
      null,
    );
    expect(r.verdicts[0]!.verdict).toBe("done");
  });

  test("a push to main counts as a deploy in repos that deploy from CI", () => {
    const r = judgeIntents(session([{ p: 1, cmd: "git push origin main" }]), [intent("I1", "Deploy the stop changes to production", [1])], null, null);
    expect(r.verdicts[0]!.verdict).toBe("done");
  });

  test("k6, emulator and node test scripts count as test runs", () => {
    for (const cmd of [
      "k6 run load-tests/k6/lifecycle.js",
      "maestro test flows/rider.yaml",
      "npx playwright test",
      "node load-tests/evidence/lifecycle.js --vus 1",
    ]) {
      const r = judgeIntents(session([{ p: 1, cmd }]), [intent("I1", "Run the one-user lifecycle test and report the metrics", [1])], null, null);
      expect(r.verdicts[0]!.actions[0]).toMatchObject({ kind: "tests", status: "ok" });
    }
  });

  test("a prohibition is not a request to act; an information request needs no action", () => {
    const long = "Here is what is missing: ".padEnd(260, "x");
    const r = judgeIntents(
      session(
        [],
        [
          { p: 1, text: long },
          { p: 2, text: long },
          { p: 3, text: long },
        ],
      ),
      [
        intent("I1", "Start filling the load-test gaps with lifecycle.js, and do not run any load tests yet", [1]),
        intent("I2", "Recommend how to run the load tests with the client to pick an instance family", [2]),
        intent("I3", "Analyze which flows lack coverage and list what to add", [3]),
      ],
      null,
      null,
    );
    expect(r.verdicts[0]!.actions).toEqual([]);
    expect(r.verdicts.slice(1).map((x) => x.verdict)).toEqual(["answered", "answered"]);
  });

  test("'get access to production' is not a deploy request", () => {
    const r = judgeIntents(session([]), [intent("I1", "Get read access to production DB and cache so metrics can be collected", [1])], null, null);
    expect(r.verdicts[0]!.actions.map((a) => a.kind)).not.toContain("deploy");
  });

  test("commands you ran yourself with '!' count as evidence and are not prompts", () => {
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    const f = buildFixture();
    const add = (text: string) =>
      appendFileSync(
        f.transcript,
        `${JSON.stringify({ type: "user", sessionId: f.sessionId, timestamp: new Date().toISOString(), origin: { kind: "human" }, message: { role: "user", content: text } })}\n`,
      );
    add("run the lifecycle load test for one user");
    add("<bash-input>k6 run load-tests/k6/lifecycle.js --vus 1</bash-input>");
    add("<bash-stdout>checks.....: 100.00%</bash-stdout><bash-stderr></bash-stderr>");
    const s = parseSession(f.transcript);
    expect(s.prompts.map((p) => p.text)).not.toContain("<bash-input>k6 run load-tests/k6/lifecycle.js --vus 1</bash-input>");
    const own = s.shell.find((r) => r.byUser)!;
    expect(own).toMatchObject({ command: "k6 run load-tests/k6/lifecycle.js --vus 1", failed: false, afterPrompt: 3 });
    const r = judgeIntents(s, [intent("I1", "Run the lifecycle load test for one user", [3])], null, null);
    expect(r.verdicts[0]!.verdict).toBe("done");
    expect(r.verdicts[0]!.actions[0]!.command).toContain("(you ran)");
  });

  test("a test request with no recognised test run lists the commands that did run", () => {
    const r = judgeIntents(
      session([{ p: 1, cmd: "adb devices && ./scripts/sos-flow.sh" }]),
      [intent("I1", "Run the payments and rider SOS flow tests", [1])],
      null,
      null,
    );
    expect(r.verdicts[0]!.verdict).toBe("not done");
    expect(r.verdicts[0]!.why).toContain("commands seen: adb devices && ./scripts/sos-flow.sh");
  });

  describe("review round 3", () => {
    const long = "Here is the full analysis you asked for. ".padEnd(260, "x");
    const fileProv = (path: string, turn: number) =>
      ({
        files: [
          {
            path,
            status: "modified",
            addedLines: 3,
            attributedLines: 3,
            otherSessionLines: 0,
            viaBackups: 0,
            turns: [turn],
            touchedByAgent: true,
            shellMentioned: false,
            inPrompts: false,
            inAgentText: true,
          },
        ],
      }) as unknown as import("../src/provenance.ts").Provenance;

    test("#1 'fix X and commit' with a commit but no code in the change is partly done, not done", () => {
      const r = judgeIntents(session([{ p: 1, cmd: "git commit -am wip" }]), [intent("I1", "Fix the receipt page and commit it", [1])], null, null);
      expect(r.verdicts[0]!.verdict).toBe("partly done");
      const withCode = judgeIntents(
        session([{ p: 1, cmd: "git commit -am fix" }]),
        [intent("I1", "Fix the receipt page and commit it", [1])],
        fileProv("api/receipt.ts", 1),
        null,
      );
      expect(withCode.verdicts[0]!.verdict).toBe("done");
    });

    test("#2 a command with no recorded result proves nothing; the last attempt decides", () => {
      const s1 = session([{ p: 1, cmd: "git push origin fix/x" }]);
      s1.shell[0]!.failed = null;
      expect(judgeIntents(s1, [intent("I1", "Push the branch", [1])], null, null).verdicts[0]!.verdict).toBe("needs judgment");
      const retried = judgeIntents(
        session([
          { p: 1, cmd: "git push", failed: true },
          { p: 1, cmd: "git push" },
        ]),
        [intent("I1", "Push the branch", [1])],
        null,
        null,
      );
      expect(retried.verdicts[0]!.actions[0]!.command).toContain("after 1 failed attempt");
      const lastFailed = judgeIntents(
        session([
          { p: 1, cmd: "git push" },
          { p: 1, cmd: "git push", failed: true },
        ]),
        [intent("I1", "Push the branch", [1])],
        null,
        null,
      );
      expect(lastFailed.verdicts[0]!.verdict).toBe("failed");
    });

    test("#3 your own command's failure is read from stdout too (test runners print there)", () => {
      expect(userCommandFailed(" FAIL  src/cart.test.ts\nTests: 1 failed, 4 passed", "")).toBe(true);
      expect(userCommandFailed("✓ 12 passed", "")).toBe(false);
      expect(userCommandFailed("", "")).toBeNull();
    });

    test("#4 a constraint offscript cannot check from files is 'not checked', not 'kept'", () => {
      const r = judgeIntents(
        session([]),
        [intent("C1", "Always use bun, not npm", [0], { kind: "constraint" }), intent("C2", "Don't touch the payments module", [1], { kind: "constraint" })],
        null,
        new Map(),
      );
      expect(r.verdicts.map((v) => v.verdict)).toEqual(["not checked", "kept"]);
    });

    test("#5 progress narration is not an answer; the reply that closes the request is", () => {
      const narrated = session(
        [],
        [
          { p: 1, text: long },
          { p: 1, text: "Running it now." },
        ],
      );
      expect(judgeIntents(narrated, [intent("I1", "Explain why the 403 happens", [1])], null, null).verdicts[0]!.verdict).not.toBe("answered");
      const closed = session(
        [],
        [
          { p: 1, text: "Looking..." },
          { p: 1, text: long },
        ],
      );
      expect(judgeIntents(closed, [intent("I1", "Explain why the 403 happens", [1])], null, null).verdicts[0]!.verdict).toBe("answered");
    });

    test("#6 nouns are not actions: push notifications, commit message parser", () => {
      const r = judgeIntents(
        session([]),
        [
          intent("I1", "Add push notifications for new rides", [1]),
          intent("I2", "Fix the commit message parser", [2]),
          intent("I3", "Resolve the merge conflicts in rides.ts", [3]),
        ],
        null,
        null,
      );
      for (const v of r.verdicts) expect(v.actions).toEqual([]);
    });

    test("#7 commands that only mention the word do not count as the action", () => {
      const r = judgeIntents(
        session([
          { p: 1, cmd: "cat .github/workflows/deploy.yml" },
          { p: 1, cmd: "git merge-base main HEAD" },
          { p: 1, cmd: "ls tests/e2e" },
        ]),
        [intent("I1", "Deploy the fix, merge the PR and run the e2e tests", [1])],
        null,
        null,
      );
      expect(r.verdicts[0]!.actions.every((a) => a.status === "missing")).toBe(true);
    });

    test("#8 'before' and 'not' do not swallow the rest of the request", () => {
      const r = judgeIntents(
        session([
          { p: 1, cmd: "git commit -m x" },
          { p: 1, cmd: "git push" },
        ]),
        [intent("I1", "Commit and push before I leave, then open a PR", [1])],
        null,
        null,
      );
      expect(r.verdicts[0]!.actions.map((a) => a.kind).sort()).toEqual(["commit", "pr", "push"]);
    });

    test("#9 two constraints from one prompt are judged separately", () => {
      const scope = new Map([
        ["api/src/payments/webhook.ts", { kind: "drift", reason: "", againstInstruction: { prompt: 1, text: "Don't touch payments" } }],
      ]) as Map<string, import("../src/scope.ts").FileScope>;
      const r = judgeIntents(
        session([]),
        [intent("C1", "Don't touch payments", [1], { kind: "constraint" }), intent("C2", "Don't touch the auth module", [1], { kind: "constraint" })],
        null,
        scope,
      );
      expect(r.verdicts.map((v) => v.verdict)).toEqual(["violated", "kept"]);
    });

    test("#10 output attaches only to the '!' command right before it", () => {
      const { appendFileSync } = require("node:fs") as typeof import("node:fs");
      const f = buildFixture();
      const add = (text: string) =>
        appendFileSync(
          f.transcript,
          `${JSON.stringify({ type: "user", sessionId: f.sessionId, timestamp: new Date().toISOString(), origin: { kind: "human" }, message: { role: "user", content: text } })}\n`,
        );
      add("<bash-input>bun test</bash-input>"); // its output record is missing
      add("now deploy");
      add("<bash-stdout></bash-stdout><bash-stderr>fatal: not a git repository</bash-stderr>"); // stray output, not bun test's
      const own = parseSession(f.transcript).shell.find((r) => r.byUser)!;
      expect(own.failed).toBeNull();
    });
  });

  test("the only merge attempt failed: failed", () => {
    const r = judgeIntents(session([{ p: 1, cmd: "gh pr merge 42", failed: true }]), [intent("I1", "Merge the PR into main", [1])], null, null);
    expect(r.verdicts[0]!.verdict).toBe("failed");
  });

  test("an information request with a real reply is answered; a change request with nothing is not done", () => {
    const long = "The 403 comes from the role middleware: ".padEnd(260, "x");
    const r = judgeIntents(
      session([], [{ p: 1, text: long }]),
      [intent("I1", "Investigate why the status endpoint returns 403", [1]), intent("I2", "Fix the receipt page error message", [3])],
      null,
      null,
    );
    expect(r.verdicts.map((v) => v.verdict)).toEqual(["answered", "not done"]);
  });

  test("superseded and cancelled requests are labelled, not judged", () => {
    const r = judgeIntents(
      session([]),
      [intent("I1", "Do not run load tests", [1], { status: "superseded", supersededBy: "I2" }), intent("I3", "Finish item 1", [2], { status: "cancelled" })],
      null,
      null,
    );
    expect(r.verdicts.map((v) => v.verdict)).toEqual(["superseded", "cancelled"]);
  });

  test("code written for a request but missing from the change: not in change", () => {
    const s = session([]);
    s.edits = [
      { seq: 1, afterPrompt: 1, toolUseId: "", tool: "Edit", filePath: "/x/a.ts", addedLines: ["x"], removedLines: [], kind: "update", failed: false },
    ];
    const r = judgeIntents(s, [intent("I1", "Fix the cart rounding bug", [1])], null, null);
    expect(r.verdicts[0]!.verdict).toBe("not in change");
  });
});

describe("worktrees", () => {
  test("lists sibling worktrees and maps their paths to repo-relative paths", () => {
    const f = buildFixture();
    const r = repoRoot(f.repo)!;
    const wt = join(mkdtempSync(join(tmpdir(), "offscript-wt-")), "shop-feature");
    gitc(r, "worktree", "add", "-q", "-b", "wt-branch", wt);
    const roots = worktreeRoots(r);
    expect(roots.length).toBe(2);
    const resolve = makeRelResolver(roots);
    expect(resolve(join(wt, "src", "cart.ts"))!.rel).toBe("src/cart.ts");
    expect(resolve(join(r, "src", "cart.ts"))!.rel).toBe("src/cart.ts");
    expect(resolve(join(tmpdir(), "elsewhere.ts"))).toBeNull();
  });
});

describe("symlinked paths (macOS /var vs /private/var)", () => {
  test.skipIf(process.platform === "win32")("finds sessions and traces lines when the repo is reached through a symlink", () => {
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    const link = join(mkdtempSync(join(tmpdir(), "offscript-link-")), "shop-link");
    symlinkSync(fx.repo, link);
    expect(findSessions(link, fx.projects).map((r) => r.id)).toEqual([fx.sessionId]);
    const s = parseSession(fx.transcript);
    const files = sessionChange(fx.repo, s)!.files;
    const viaLink = traceProvenance(link, s, files);
    expect(viaLink.coverage).toBe(traceProvenance(root, s, files).coverage);
    expect(viaLink.editsOutsideRepo).toBe(0);
  });
});

describe("intent ledger via headless claude", () => {
  test("calls the CLI with safety flags, parses fenced JSON, never sends the diff", () => {
    const dir = mkdtempSync(join(tmpdir(), "offscript-fake-"));
    process.env.OFFSCRIPT_CLAUDE_BIN = fakeClaude(dir);
    const s = parseSession(fx.transcript);
    const ledger = buildIntentLedger(s, root, true);
    delete process.env.OFFSCRIPT_CLAUDE_BIN;
    expect(ledger.error).toBeNull();
    expect(ledger.intents.map((i) => i.kind)).toEqual(["task", "constraint"]);
    expect(ledger.costUsd).toBe(0.0012);
    const args = readFileSync(join(dir, "args.txt"), "utf8");
    for (const flag of ["-p", "--model haiku", "--safe-mode", "--disallowedTools", "--no-session-persistence", "--max-turns 1"]) {
      expect(args).toContain(flag);
    }
    const stdin = readFileSync(join(dir, "stdin.txt"), "utf8");
    expect(stdin).toContain("[1] Add a discount parameter");
    expect(stdin).not.toContain("FAKEFAKEFAKE");
    expect(stdin).not.toContain("return sum - discount"); // leakage rule: no code
  });
});

describe("report", () => {
  test("renders all sections with a label block", () => {
    const s = parseSession(fx.transcript);
    const change = sessionChange(root, s)!;
    const files = change.files;
    const facts = extractFacts(files);
    const provenance = traceProvenance(root, s, files);
    const md = renderSession({
      session: s,
      repo: root,
      range: { label: change.label },
      facts,
      provenance,
      ledger: {
        intents: [],
        claims: [{ text: "All tests pass", type: "tests_pass" }],
        confidence: "low",
        notes: "",
        backend: "none",
        costUsd: null,
        error: null,
      },
      tests: checkTests(s, root),
      flags: fileFlags(provenance, facts, classifyScope({ provenance, prompts: s.prompts, roots: [root] })),
      scope: classifyScope({ provenance, prompts: s.prompts, roots: [root] }),
      error: null,
    });
    for (const h of [
      "## 1.",
      "## 2.",
      "## 3.",
      "## 4.",
      "## 5.",
      "## 6.",
      "intents_correct (y/n):",
      "**undisclosed**",
      "**against-instruction**",
      "anchor: named in your prompts",
      "[verified]",
    ]) {
      expect(md).toContain(h);
    }
    expect(md).not.toContain("FAKEFAKEFAKE");
  });
});

describe("unit", () => {
  test("redact keeps assignment names but hides values", () => {
    const r = redact("DATABASE_URL=postgres://user:hunter2pass@db:5432/x and api_key: abcdef123456");
    expect(r.text).toContain("postgres://user:[REDACTED:url-credentials]@db");
    expect(r.text).toContain("api_key: [REDACTED:assignment]");
  });
  test("test command detection", () => {
    for (const c of ["npm test", "bun test", "pnpm run test", "npx vitest run", "pytest -q", "go test ./...", "php artisan test"])
      expect(TEST_COMMAND_RE.test(c)).toBe(true);
    for (const c of ["npm run build", "git status", "cat test.txt"]) expect(TEST_COMMAND_RE.test(c)).toBe(false);
  });
});
