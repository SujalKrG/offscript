import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTests, fileFlags, verdictForClaim } from "../src/checks.ts";
import { extractFacts } from "../src/facts.ts";
import { makeRelResolver, repoRoot, sessionChange, worktreeRoots } from "../src/git.ts";
import { findSessions, parseSession, TEST_COMMAND_RE } from "../src/ingest/claude-code.ts";
import { buildIntentLedger } from "../src/intent.ts";
import { buildOtherSessionIndex, traceProvenance } from "../src/provenance.ts";
import { redact } from "../src/redact.ts";
import { renderSession } from "../src/report.ts";
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

  test("flags: auth edit is undisclosed and sensitive", () => {
    const flags = fileFlags(prov, facts);
    expect(flags.get("src/auth/session.ts")).toEqual(expect.arrayContaining(["undisclosed", "sensitive"]));
    expect(flags.get("src/coupon.ts")).not.toContain("undisclosed");
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
      flags: fileFlags(provenance, facts),
      error: null,
    });
    for (const h of ["## 1.", "## 2.", "## 3.", "## 4.", "## 5.", "## 6.", "intents_correct (y/n):", "**undisclosed**", "[verified]"]) {
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
