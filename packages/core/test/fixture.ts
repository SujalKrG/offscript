// Builds a throwaway git repo plus a Claude Code style transcript that edits it.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sh(cwd: string, args: string[]) {
  const past = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

export interface Fixture {
  repo: string;
  projects: string;
  transcript: string;
  sessionId: string;
}

let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, "0")}`;

export function buildFixture(opts: { subagent?: boolean; backups?: boolean } = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "offscript-fixture-"));
  const repo = join(base, "shop");
  const projects = join(base, "claude", "projects");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  mkdirSync(join(repo, "src", "auth"), { recursive: true });

  writeFileSync(
    join(repo, "src", "cart.ts"),
    "export function total(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n\nexport function legacyTotal(x: number[]) {\n  return x.length;\n}\n",
  );
  writeFileSync(join(repo, "src", "auth", "session.ts"), "export const TTL = 3600;\n");
  writeFileSync(
    join(repo, "tests", "cart.test.ts"),
    "import { total } from '../src/cart';\ntest('sums', () => {\n  expect(total([1, 2])).toBe(3);\n  expect(total([])).toBe(0);\n});\n",
  );
  sh(repo, ["init", "-q"]);
  sh(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  sh(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);

  // Working-tree changes made "by the agent"
  writeFileSync(
    join(repo, "src", "cart.ts"),
    "export function total(items: number[], discount = 0) {\n  const sum = items.reduce((a, b) => a + b, 0);\n  return sum - discount;\n}\n",
  );
  // coupon.ts: written by the agent, then one line added by hand (not in the transcript)
  writeFileSync(
    join(repo, "src", "coupon.ts"),
    "export function applyCoupon(code: string) {\n  return code === 'SAVE10' ? 10 : 0;\n}\nexport const COUPON_NOTE = 'added by a human';\n",
  );
  writeFileSync(join(repo, "src", "auth", "session.ts"), "export const TTL = 86400;\n");
  writeFileSync(
    join(repo, "tests", "cart.test.ts"),
    "import { total } from '../src/cart';\ntest.skip('sums', () => {\n  expect(total([1, 2])).toBe(3);\n});\n",
  );
  // A human edit, not in the transcript
  writeFileSync(join(repo, "README.md"), "# Shop\nHand written note.\n");

  const sessionId = "abcdef12-3456-4789-8abc-def012345678";
  const dir = join(projects, repo.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  let t = 0;
  const ts = () => {
    t += 1000;
    return new Date(now - 60_000 + t).toISOString();
  };
  const common = () => ({ sessionId, cwd: repo, gitBranch: "main", version: "2.1.300", uuid: uuid(), timestamp: ts() });
  const recs: unknown[] = [];
  const user = (text: string) =>
    recs.push({ ...common(), type: "user", origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text }] } });
  const meta = (text: string) => recs.push({ ...common(), type: "user", isMeta: true, message: { role: "user", content: text } });
  const say = (text: string) => recs.push({ ...common(), type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  const tool = (id: string, name: string, input: unknown, result: unknown, isError = false) => {
    recs.push({ ...common(), type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    recs.push({
      ...common(),
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }] },
      toolUseResult: result,
    });
  };

  meta("<system-reminder>ignore me</system-reminder>");
  // Built at runtime so secret scanners never see a key-shaped literal in the source.
  const fakeKey = ["sk", "ant", "api03", "FAKEFAKEFAKEFAKEFAKEFAKE123"].join("-");
  user(`Add a discount parameter to total() in cart.ts and a coupon helper. My key is ${fakeKey} btw. Don't touch auth.`);
  say("I'll update cart.ts and add src/coupon.ts.");
  tool(
    "t1",
    "Edit",
    { file_path: join(repo, "src", "cart.ts"), old_string: "x", new_string: "y" },
    {
      filePath: join(repo, "src", "cart.ts"),
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          lines: [
            "-export function total(items: number[]) {",
            "-  return items.reduce((a, b) => a + b, 0);",
            "+export function total(items: number[], discount = 0) {",
            "+  const sum = items.reduce((a, b) => a + b, 0);",
            "+  return sum - discount;",
            " }",
          ],
        },
      ],
      originalFile: null,
      userModified: false,
    },
  );
  tool(
    "t2",
    "Write",
    { file_path: join(repo, "src", "coupon.ts"), content: "" },
    {
      type: "create",
      filePath: join(repo, "src", "coupon.ts"),
      content: "export function applyCoupon(code: string) {\n  return code === 'SAVE10' ? 10 : 0;\n}\n",
      structuredPatch: [],
      originalFile: null,
    },
  );
  if (opts.backups) {
    // Claude Code backs up coupon.ts (it did not exist yet) before the agent's first edit to it...
    recs.push({
      type: "file-history-delta",
      messageId: uuid(),
      trackingPath: "src/coupon.ts",
      backup: { backupFileName: null, version: 1, backupTime: ts(), realParentDir: join(repo, "src") },
      timestamp: ts(),
    });
  }
  // ...then the agent appends a line with a script, which no edit tool records.
  tool("t3", "Bash", { command: opts.backups ? "python add_note.py && npm test" : "npm test" }, { stdout: "1 failed", stderr: "" }, true);
  if (opts.backups) {
    // At the next prompt, Claude Code backs up the file again: v2 holds the script's line too.
    const at = ts();
    recs.push({
      type: "file-history-snapshot",
      messageId: uuid(),
      snapshot: {
        messageId: "m",
        timestamp: at,
        trackedFileBackups: { "src/coupon.ts": { backupFileName: "c0ffee0000000001@v2", version: 2, backupTime: at, realParentDir: join(repo, "src") } },
      },
      isSnapshotUpdate: false,
    });
    const fh = join(base, "claude", "file-history", sessionId);
    mkdirSync(fh, { recursive: true });
    writeFileSync(
      join(fh, "c0ffee0000000001@v2"),
      "export function applyCoupon(code: string) {\n  return code === 'SAVE10' ? 10 : 0;\n}\nexport const COUPON_NOTE = 'added by a human';\n",
    );
  }
  user("tests are failing, fix them");
  tool(
    "t4",
    "Edit",
    { file_path: join(repo, "tests", "cart.test.ts"), old_string: "a", new_string: "b" },
    {
      filePath: join(repo, "tests", "cart.test.ts"),
      structuredPatch: [
        {
          oldStart: 2,
          oldLines: 4,
          newStart: 2,
          newLines: 3,
          lines: ["-test('sums', () => {", "+test.skip('sums', () => {", "   expect(total([1, 2])).toBe(3);", "-  expect(total([])).toBe(0);", " });"],
        },
      ],
    },
  );
  tool(
    "t5",
    "Edit",
    { file_path: join(repo, "src", "auth", "session.ts"), old_string: "3600", new_string: "86400" },
    {
      filePath: join(repo, "src", "auth", "session.ts"),
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-export const TTL = 3600;", "+export const TTL = 86400;"] }],
    },
  );
  tool("t6", "Bash", { command: "npm test" }, { stdout: "all passed", stderr: "" }, false);
  say("Done. All tests pass and the discount is implemented.");
  recs.push({ type: "weird-new-type", sessionId });

  const transcript = join(dir, `${sessionId}.jsonl`);
  writeFileSync(transcript, `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);

  if (opts.subagent) {
    // A Task-tool subagent, stored beside the main transcript, adds the COUPON_NOTE line.
    const subDir = join(dir, sessionId, "subagents");
    mkdirSync(subDir, { recursive: true });
    const at = new Date(now - 60_000 + 12_500).toISOString(); // after prompt 2, before the last test run
    const sub = [
      {
        sessionId,
        cwd: repo,
        isSidechain: true,
        type: "user",
        uuid: uuid(),
        timestamp: at,
        message: { role: "user", content: "Add a note constant to coupon.ts" },
      },
      {
        sessionId,
        cwd: repo,
        isSidechain: true,
        type: "assistant",
        uuid: uuid(),
        timestamp: at,
        message: { role: "assistant", content: [{ type: "tool_use", id: "s1", name: "Edit", input: { file_path: join(repo, "src", "coupon.ts") } }] },
      },
      {
        sessionId,
        cwd: repo,
        isSidechain: true,
        type: "user",
        uuid: uuid(),
        timestamp: at,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s1", content: "ok" }] },
        toolUseResult: {
          filePath: join(repo, "src", "coupon.ts"),
          structuredPatch: [{ oldStart: 4, oldLines: 0, newStart: 4, newLines: 1, lines: ["+export const COUPON_NOTE = 'added by a human';"] }],
        },
      },
    ];
    writeFileSync(join(subDir, "agent-a1b2c3.jsonl"), `${sub.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
  return { repo, projects, transcript, sessionId };
}

/**
 * A fake `claude` CLI that returns a canned intent ledger and records its args and stdin.
 * The logic is a Bun script; the launcher is a .cmd on Windows (run through cmd.exe, like the real
 * npm-installed `claude.cmd`) and a shell script elsewhere, so the test runs on every OS.
 */
export function fakeClaude(dir: string): string {
  const envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.0012,
    result: `\`\`\`json\n${JSON.stringify({
      intents: [
        {
          id: "I1",
          text: "Add a discount parameter to total()",
          kind: "task",
          sourcePrompts: [1],
          quote: "Add a discount parameter",
          status: "active",
          supersededBy: null,
        },
        { id: "I2", text: "Do not touch auth", kind: "constraint", sourcePrompts: [1], quote: "Don't touch auth", status: "active", supersededBy: null },
      ],
      claims: [{ text: "All tests pass", type: "tests_pass" }],
      confidence: "high",
      notes: "",
    })}\n\`\`\``,
  };
  const script = join(dir, "fake-claude.ts");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.1.300 (Claude Code)");
  process.exit(0);
}
writeFileSync(${JSON.stringify(join(dir, "args.txt"))}, args.join(" "));
writeFileSync(${JSON.stringify(join(dir, "stdin.txt"))}, await Bun.stdin.text());
console.log(${JSON.stringify(JSON.stringify(envelope))});
`,
  );
  if (process.platform === "win32") {
    const cmd = join(dir, "fake-claude.cmd");
    writeFileSync(cmd, `@"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const sh = join(dir, "fake-claude");
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(sh, 0o755);
  return sh;
}
