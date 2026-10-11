import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTests, fileFlags, verdictForClaim } from "../src/checks.ts";
import { extractFacts } from "../src/facts.ts";
import { diff, repoRoot, resolveRange } from "../src/git.ts";
import { findSessions, parseSession, TEST_COMMAND_RE } from "../src/ingest/claude-code.ts";
import { buildIntentLedger } from "../src/intent.ts";
import { traceProvenance } from "../src/provenance.ts";
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

describe("facts + provenance + checks", () => {
  const s = parseSession(fx.transcript);
  const range = resolveRange(root, s)!;
  const files = diff(root, range);
  const facts = extractFacts(files);
  const prov = traceProvenance(root, s, files);

  test("range falls back to uncommitted changes", () => {
    expect(range.head).toBeNull();
    expect(files.map((f) => f.path).sort()).toEqual(["README.md", "src/auth/session.ts", "src/cart.ts", "src/coupon.ts", "tests/cart.test.ts"]);
  });

  test("hard facts", () => {
    expect(facts.added.sort()).toEqual(["README.md", "src/coupon.ts"]);
    expect(facts.sensitiveFiles).toContain("src/auth/session.ts");
    expect(facts.removedSymbols.map((x) => x.symbol)).toContain("legacyTotal");
    expect(facts.removedSymbols.map((x) => x.symbol)).not.toContain("total");
    expect(facts.testIntegrity.skipsAdded.length).toBe(1);
    expect(facts.testIntegrity.assertionsRemoved).toBeGreaterThan(facts.testIntegrity.assertionsAdded);
  });

  test("provenance traces agent lines and leaves the human README untraced", () => {
    const byPath = new Map(prov.files.map((f) => [f.path, f]));
    expect(byPath.get("src/cart.ts")!.attributedLines).toBe(byPath.get("src/cart.ts")!.addedLines);
    expect(byPath.get("src/cart.ts")!.turns).toEqual([1]);
    expect(byPath.get("tests/cart.test.ts")!.turns).toEqual([2]);
    expect(byPath.get("README.md")!.attributedLines).toBe(0);
    expect(byPath.get("README.md")!.touchedByAgent).toBe(false);
    expect(prov.coverage).toBeGreaterThan(0.6);
    expect(prov.coverage).toBeLessThan(1);
  });

  test("flags: auth edit is undisclosed and sensitive; README is not from edit tools", () => {
    const flags = fileFlags(prov, facts);
    expect(flags.get("src/auth/session.ts")).toEqual(expect.arrayContaining(["undisclosed", "sensitive"]));
    expect(flags.get("src/coupon.ts")).not.toContain("undisclosed");
    expect(flags.get("README.md")).toContain("not-from-edit-tools");
  });

  test("test evidence: passed after last edit verifies a tests_pass claim", () => {
    const t = checkTests(s, root);
    expect(t.evidence).toBe("passed-after-last-edit");
    expect(verdictForClaim({ text: "All tests pass", type: "tests_pass" }, t)).toBe("verified");
  });
});

describe("diff range from commits made during the session", () => {
  test("uses parent-of-first..last commit when the tree is clean", () => {
    const f2 = buildFixture();
    const r2 = repoRoot(f2.repo)!;
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    spawnSync("git", ["-C", r2, "add", "-A"]);
    spawnSync("git", ["-C", r2, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "agent work"]);
    const s2 = parseSession(f2.transcript);
    const range = resolveRange(r2, s2)!;
    expect(range.commits.length).toBe(1);
    expect(range.head).toBe(range.commits[0]!);
    const prov = traceProvenance(r2, s2, diff(r2, range));
    expect(prov.files.find((f) => f.path === "src/cart.ts")!.turns).toEqual([1]);
  });
});

describe("intent ledger via headless claude", () => {
  // The fake CLI is a bash script, so this one test runs on macOS/Linux/CI only.
  test.skipIf(process.platform === "win32")("calls the CLI with safety flags, parses fenced JSON, never sends the diff", () => {
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
    const range = resolveRange(root, s)!;
    const files = diff(root, range);
    const facts = extractFacts(files);
    const provenance = traceProvenance(root, s, files);
    const md = renderSession({
      session: s,
      repo: root,
      range,
      facts,
      provenance,
      ledger: { intents: [], claims: [{ text: "All tests pass", type: "tests_pass" }], confidence: "low", notes: "", backend: "none", costUsd: null, error: null },
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
    for (const c of ["npm test", "bun test", "pnpm run test", "npx vitest run", "pytest -q", "go test ./...", "php artisan test"]) expect(TEST_COMMAND_RE.test(c)).toBe(true);
    for (const c of ["npm run build", "git status", "cat test.txt"]) expect(TEST_COMMAND_RE.test(c)).toBe(false);
  });
});
