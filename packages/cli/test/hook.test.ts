import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fakeClaude } from "../../core/test/fixture.ts";
import { hookCommand, hookMessage, hookOutput, installHook, parseHookInput, settingsPath } from "../src/hook.ts";
import { run } from "../src/main.ts";
import type { Summary } from "../src/summary.ts";
import { emptyDir, makeIo, setup } from "./helpers.ts";

const t = setup();
afterAll(() => t.restore());
const repo = t.fx.repo;

describe("review --hook", () => {
  const input = () => JSON.stringify({ transcript_path: t.fx.transcript, session_id: t.fx.sessionId, cwd: repo, hook_event_name: "SessionEnd" });

  test("reviews the session named on stdin and prints exactly one line", async () => {
    const o = makeIo(emptyDir("elsewhere"), { stdin: input() });
    const code = await run(["review", "--hook", "--no-llm"], o.io);
    expect(code).toBe(0); // never blocks, even with problems
    const lines = o.stdout().trimEnd().split("\n");
    expect(lines.length).toBe(1);
    const msg = JSON.parse(lines[0]!).systemMessage as string;
    expect(msg).toStartWith("offscript abcdef12: 1 against your instructions.");
    expect(msg).toContain("Report: ");
    expect(msg).not.toContain("—");
    expect(readdirSync(join(repo, ".offscript", "reports")).some((f) => f.endsWith("abcdef12.md"))).toBe(true);
    expect(o.stderr()).toBe("");
  });

  test("finds the session by id when there is no transcript path", async () => {
    const o = makeIo(repo, { stdin: JSON.stringify({ session_id: "abcdef12", cwd: repo }) });
    expect(await run(["review", "--hook", "--no-llm"], o.io)).toBe(0);
    expect(JSON.parse(o.stdout()).systemMessage).toContain("abcdef12");
  });

  test("bad input, a missing session or a non-repo each print one line and exit 0", async () => {
    for (const stdin of [
      "not json",
      "[]",
      JSON.stringify({ cwd: emptyDir("x") }),
      JSON.stringify({ cwd: repo, session_id: "nope" }),
      JSON.stringify({ cwd: repo }),
    ]) {
      const o = makeIo(repo, { stdin });
      expect(await run(["review", "--hook", "--no-llm"], o.io)).toBe(0);
      const lines = o.stdout().trimEnd().split("\n");
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]!).systemMessage).toStartWith("offscript");
    }
  });

  test("a session without edits is skipped", async () => {
    const transcript = join(dirname(t.fx.transcript), "noedits.jsonl");
    const rec = {
      type: "user",
      sessionId: "noedits0",
      cwd: repo,
      uuid: "u1",
      timestamp: new Date().toISOString(),
      origin: { kind: "human" },
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    };
    writeFileSync(transcript, `${JSON.stringify(rec)}\n`);
    const o = makeIo(repo, { stdin: JSON.stringify({ transcript_path: transcript, cwd: repo }) });
    expect(await run(["review", "--hook", "--no-llm"], o.io)).toBe(0);
    expect(JSON.parse(o.stdout()).systemMessage).toContain("nothing to review");
  });

  test("a hook with no stdin input gives up after the timeout and still exits 0 with one line", async () => {
    const o = makeIo(repo, { stdin: input() });
    o.io.readStdin = () => new Promise<string>(() => {}); // an open pipe nobody writes to
    o.io.stdinTimeoutMs = 50;
    expect(await run(["review", "--hook", "--no-llm"], o.io)).toBe(0);
    const lines = o.stdout().trimEnd().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).systemMessage).toContain("no hook input on stdin");
  });

  test("a hung model call is cut short and the hook falls back to the heuristic ledger", async () => {
    const hung = setup();
    process.env.OFFSCRIPT_CLAUDE_BIN = fakeClaude(hung.dir, { hangMs: 5000 });
    try {
      const o = makeIo(hung.fx.repo, { stdin: JSON.stringify({ transcript_path: hung.fx.transcript, cwd: hung.fx.repo }) });
      o.io.modelTimeoutMs = 400;
      const started = Date.now();
      expect(await run(["review", "--hook"], o.io)).toBe(0);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(hung.calls()).toBe(1);
      expect(o.stdout().trimEnd().split("\n").length).toBe(1);
      expect(JSON.parse(o.stdout()).systemMessage).toStartWith("offscript abcdef12");
    } finally {
      hung.restore();
    }
  });

  test("hookMessage and parseHookInput", () => {
    const s = {
      requests: 4,
      did: { done: 4, partly: 0, notDone: 0, unclear: 0 },
      scope: { againstInstruction: 0, unexplained: 0, checked: true },
      truth: { contradicted: 0, stale: 0, overstated: 0, unsupported: 0, verified: 0, silentGaps: 0 },
      tracedPct: 100,
      problems: [],
      notes: [],
    } satisfies Summary;
    expect(hookMessage("abcdef1234", s, null)).toBe("offscript abcdef12: no problems (4 of 4 requests done).");
    const bad = {
      ...s,
      did: { ...s.did, notDone: 1, partly: 2 },
      truth: { ...s.truth, contradicted: 1, stale: 1, silentGaps: 1 },
      scope: { ...s.scope, unexplained: 3 },
    };
    expect(hookMessage("abcdef1234", bad, "r.md")).toBe(
      "offscript abcdef12: 1 not done, 2 partly done, 1 contradicted, 1 doubtful claims, 1 silent gaps, 3 unexplained files. Report: r.md",
    );
    expect(parseHookInput('{"transcript_path":"/a","session_id":"s","cwd":"/c","extra":1}')).toEqual({ transcriptPath: "/a", sessionId: "s", cwd: "/c" });
    expect(parseHookInput("{}")).toEqual({ transcriptPath: null, sessionId: null, cwd: null });
    expect(hookOutput("x")).toBe('{"systemMessage":"x"}');
  });
});

describe("hook install", () => {
  test("creates the project settings file with a 60 second timeout", async () => {
    const dir = emptyDir("proj");
    const o = makeIo(dir);
    expect(await run(["hook", "install"], o.io)).toBe(0);
    expect(o.stdout()).toContain("Created .claude/settings.json");
    const s = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    const h = s.hooks.SessionEnd[0].hooks[0];
    expect(h.type).toBe("command");
    expect(h.timeout).toBe(60);
    expect(h.command).toMatch(/^bun ".*main\.ts" review --hook$/);
  });

  test("merges into existing settings without dropping keys, and is idempotent", async () => {
    const dir = emptyDir("proj2");
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(dirname(file), { recursive: true });
    const before = {
      model: "opus",
      permissions: { allow: ["Bash(git status)"], deny: [] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "echo bye", timeout: 5 }] }],
      },
    };
    writeFileSync(file, JSON.stringify(before));
    expect(await run(["hook", "install"], makeIo(dir).io)).toBe(0);
    const once = readFileSync(file, "utf8");
    const s = JSON.parse(once);
    expect(s.model).toBe("opus");
    expect(s.permissions).toEqual(before.permissions);
    expect(s.hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
    expect(s.hooks.SessionEnd[0]).toEqual(before.hooks.SessionEnd[0]);
    expect(s.hooks.SessionEnd.length).toBe(2);
    const o = makeIo(dir);
    expect(await run(["hook", "install"], o.io)).toBe(0);
    expect(o.stdout()).toContain("already installed");
    expect(readFileSync(file, "utf8")).toBe(once);
    expect(readdirSync(dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("an older entry is updated in place, not duplicated", () => {
    const dir = emptyDir("proj3");
    const file = join(dir, "settings.json");
    const old = { type: "command", command: "bun /old/offscript/main.ts review --hook", timeout: 2, extra: true };
    writeFileSync(file, JSON.stringify({ hooks: { SessionEnd: [{ matcher: "", hooks: [old] }] } }));
    const command = 'bun "/new/offscript/main.ts" review --hook';
    expect(installHook(file, command).action).toBe("updated");
    const s = JSON.parse(readFileSync(file, "utf8"));
    expect(s.hooks.SessionEnd.length).toBe(1);
    expect(s.hooks.SessionEnd[0].matcher).toBe("");
    expect(s.hooks.SessionEnd[0].hooks[0]).toEqual({ type: "command", command, timeout: 60, extra: true });
    expect(installHook(file, command).action).toBe("unchanged");
  });

  test("the hook command uses forward slashes so Git Bash on Windows keeps the path", () => {
    const c = hookCommand("C:\\Users\\Su jal\\drift-reviewer\\packages\\cli\\src\\main.ts");
    expect(c).toBe('bun "C:/Users/Su jal/drift-reviewer/packages/cli/src/main.ts" review --hook');
    expect(hookCommand('/a/b"c$d')).toBe('bun "/a/b\\"c\\$d" review --hook');
    const file = join(emptyDir("win"), "settings.json");
    writeFileSync(
      file,
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "bun C:\\old\\cli\\src\\main.ts review --hook", timeout: 60 }] }] } }),
    );
    expect(installHook(file, c).action).toBe("updated"); // an old backslash entry is recognised and rewritten, not duplicated
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.SessionEnd.length).toBe(1);
  });

  test("a settings file with a UTF-8 BOM (PowerShell Out-File) is merged, not refused", () => {
    const file = join(emptyDir("bom"), "settings.json");
    writeFileSync(file, `\uFEFF${JSON.stringify({ model: "opus" })}`);
    expect(installHook(file, 'bun "/x/offscript/main.ts" review --hook').action).toBe("added");
    const s = JSON.parse(readFileSync(file, "utf8"));
    expect(s.model).toBe("opus");
    expect(s.hooks.SessionEnd.length).toBe(1);
  });

  test("--user writes under CLAUDE_CONFIG_DIR", async () => {
    const cfg = emptyDir("cfg");
    const o = makeIo(emptyDir("somewhere"), { env: { CLAUDE_CONFIG_DIR: cfg } });
    expect(await run(["hook", "install", "--user"], o.io)).toBe(0);
    expect(existsSync(join(cfg, "settings.json"))).toBe(true);
    expect(settingsPath("user", "/r", { CLAUDE_CONFIG_DIR: "/c" })).toBe(join("/c", "settings.json"));
    expect(settingsPath("user", "/r", {}).endsWith(join(".claude", "settings.json"))).toBe(true);
  });

  test("broken settings are refused and left untouched", async () => {
    const dir = emptyDir("proj4");
    const file = join(dir, ".claude", "settings.json");
    mkdirSync(dirname(file), { recursive: true });
    for (const text of ["{ nope", "[]", '{"hooks": []}', '{"hooks": {"SessionEnd": {}}}']) {
      writeFileSync(file, text);
      const o = makeIo(dir);
      expect(await run(["hook", "install"], o.io)).toBe(2);
      expect(o.stderr()).toContain("left alone");
      expect(readFileSync(file, "utf8")).toBe(text);
    }
    writeFileSync(file, "  \n");
    expect(await run(["hook", "install"], makeIo(dir).io)).toBe(0);
  });

  test("--project with --user is a usage error", async () => {
    expect(await run(["hook", "install", "--project", "--user"], makeIo(emptyDir("p")).io)).toBe(2);
  });
});
