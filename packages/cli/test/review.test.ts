import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realIo, run, USAGE } from "../src/main.ts";
import { emptyDir, makeIo, normalize, setup } from "./helpers.ts";

const t = setup();
afterAll(() => t.restore());
const repo = t.fx.repo;

async function cli(args: string[], extra: Parameters<typeof makeIo>[1] = {}) {
  const o = makeIo(repo, extra);
  const code = await run(args, o.io);
  return { code, out: o.stdout(), err: o.stderr() };
}

describe("review --no-llm", () => {
  test("renders the short terminal view in ASCII, never spawns claude, writes the report", async () => {
    const r = await cli(["review", "--no-llm"]);
    expect(r.code).toBe(0); // problems were found, but a plain review is not a CI gate
    expect(normalize(r.out)).toBe(
      [
        "offscript  abcdef12  DATE TIME  2 requests, 4 edits, 89% traced",
        "",
        "  Did what you asked    [ok] 2 done",
        "  Only what you asked   [x] 1 against your instructions",
        "  Told the truth        [ok] 1 claim verified",
        "",
        "  Problems",
        '  [x] src/auth/session.ts  changed against your instruction: "Don\'t touch auth."',
        "",
        "  Full report  .offscript/reports/DATE-abcdef12.md",
        "",
      ].join("\n"),
    );
    expect(t.calls()).toBe(0);
    expect(t.cacheFiles()).toEqual([]);
    const dir = join(repo, ".offscript", "reports");
    const report = join(dir, readdirSync(dir).find((f) => f.endsWith("-abcdef12.md")) ?? "missing.md");
    expect(existsSync(report)).toBe(true);
    expect(readFileSync(report, "utf8")).toContain("## 1b.");
  });

  test("a terminal gets Unicode glyphs and colour, NO_COLOR gets neither", async () => {
    // Windows decides by terminal markers, not locale, so pin them: set for the UTF-8 cases, cleared for the legacy one.
    const utf8Term = { WT_SESSION: "test", TERM_PROGRAM: "", ConEmuANSI: "" };
    const legacyTerm = { WT_SESSION: "", TERM_PROGRAM: "", ConEmuANSI: "" };
    const fancy = await cli(["review", "--no-llm"], { tty: true, env: { ...utf8Term, LANG: "en_US.UTF-8", NO_COLOR: "" } });
    expect(fancy.out).toContain("✔");
    expect(fancy.out).toContain("\x1b[");
    const plain = await cli(["review", "--no-llm"], { tty: true, env: { ...utf8Term, LANG: "en_US.UTF-8", NO_COLOR: "1" } });
    expect(plain.out).not.toContain("✔");
    expect(plain.out).not.toContain("\x1b[");
    expect(plain.out).toContain("[ok]");
    const latin = await cli(["review", "--no-llm"], { tty: true, env: { ...legacyTerm, LANG: "C", LC_ALL: "", NO_COLOR: "" } });
    expect(latin.out).toContain("[ok]");
  });

  test("--full lists every request, claim and flagged file", async () => {
    const r = await cli(["review", "--no-llm", "--full"]);
    for (const h of ["Every request", "Every claim", "Flagged files", "Worth a look"]) expect(r.out).toContain(h);
  });

  test("--json has a stable schema", async () => {
    const r = await cli(["review", "--no-llm", "--json"]);
    const j = JSON.parse(r.out);
    expect(j.schemaVersion).toBe(1);
    expect(Object.keys(j)).toEqual([
      "schemaVersion",
      "tool",
      "session",
      "ledger",
      "summary",
      "problems",
      "notes",
      "requests",
      "claims",
      "silentGaps",
      "files",
      "tests",
      "reportPath",
    ]);
    expect(j.session.id).toBe(t.fx.sessionId);
    expect(j.ledger.source).toBe("heuristic");
    expect(j.summary.requests).toBe(2);
    expect(j.summary.againstInstruction).toBe(1);
    expect(j.problems[0].kind).toBe("file");
    expect(j.files.map((f: { path: string }) => f.path)).toContain("src/auth/session.ts");
    expect(j.reportPath).toContain("abcdef12.md");
    expect(r.err).toBe("");
  });

  test("--md moves the report", async () => {
    const r = await cli(["review", "--no-llm", "--md", "out/review.md"]);
    expect(r.out).toContain("Full report  out/review.md");
    expect(existsSync(join(repo, "out", "review.md"))).toBe(true);
  });

  test("a report that cannot be written is a warning, not a crash", async () => {
    const r = await cli(["review", "--no-llm", "--md", join(repo, "README.md", "x.md")]); // README.md is a file
    expect(r.err).toContain("could not write the report");
    expect(r.out).not.toContain("Full report");
  });
});

describe("exit codes", () => {
  test("a plain review exits 0 even with problems; --fail-on problems and any opt in to 1", async () => {
    expect((await cli(["review", "--no-llm"])).code).toBe(0);
    expect((await cli(["review", "--no-llm", "--fail-on", "problems"])).code).toBe(1);
    expect((await cli(["review", "--no-llm", "--fail-on", "never"])).code).toBe(0);
  });
  test("--fail-on never is 0, any is 1", async () => {
    expect((await cli(["review", "--no-llm", "--fail-on", "never"])).code).toBe(0);
    expect((await cli(["review", "--no-llm", "--fail-on", "any"])).code).toBe(1);
  });
  test("USAGE documents the default", () => {
    expect(USAGE).toContain("never (default) | problems | any");
  });
  test("usage errors are 2", async () => {
    expect((await cli(["review", "--bogus"])).code).toBe(2);
    expect((await cli(["review", "--fail-on", "sometimes"])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
    expect((await cli(["frobnicate"])).code).toBe(2);
    expect((await cli(["hook"])).code).toBe(2);
    expect((await cli(["review", "a", "b"])).code).toBe(2);
    expect((await cli(["list", "--limit", "0"])).code).toBe(2);
    const o = makeIo(emptyDir("not-a-repo"));
    expect(await run(["review"], o.io)).toBe(2);
    expect(o.stderr()).toContain("not a git repository");
    expect(await run(["list"], makeIo(emptyDir("not-a-repo")).io)).toBe(2);
  });
  test("no session is 3", async () => {
    expect((await cli(["review", "--no-llm", "zzz"])).code).toBe(3);
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = emptyDir("claude");
    try {
      const r = await cli(["review", "--no-llm"]);
      expect(r.code).toBe(3);
      expect(r.err).toContain("no Claude Code session");
      expect((await cli(["list"])).code).toBe(3);
    } finally {
      process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
  test("a prefix picks the session", async () => {
    expect((await cli(["review", "--no-llm", "abcdef"])).code).toBe(0);
  });
  test("--help is 0 and OFFSCRIPT_INNER does nothing", async () => {
    const h = await cli(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toContain("offscript review");
    expect(h.out).not.toContain("—");
    const inner = await cli(["review"], { env: { OFFSCRIPT_INNER: "1" } });
    expect(inner).toEqual({ code: 0, out: "", err: "" });
  });
});

describe("cache", () => {
  test("the second review does not call claude; a changed prompt misses", async () => {
    const first = JSON.parse((await cli(["review", "--json", "--fail-on", "never"])).out);
    expect(first.ledger.source).toBe("model");
    expect(first.requests.map((r: { id: string }) => r.id)).toEqual(["I1", "I2"]);
    expect(t.calls()).toBe(1);
    const second = JSON.parse((await cli(["review", "--json", "--fail-on", "never"])).out);
    expect(second.ledger.source).toBe("cache");
    expect(second.ledger.backend).toContain("cached");
    expect(second.requests).toEqual(first.requests);
    expect(t.calls()).toBe(1);
    // the atomic write leaves only the finished entry
    expect(t.cacheFiles().length).toBe(1);
    expect(t.cacheFiles()[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });
});

describe("fallbacks", () => {
  test("a failing model falls back to the heuristic ledger and says so", async () => {
    const bad = setup({ fail: true });
    try {
      const o = makeIo(bad.fx.repo);
      const code = await run(["review", "--json", "--fail-on", "never"], o.io);
      expect(code).toBe(0);
      expect(JSON.parse(o.stdout()).ledger.source).toBe("heuristic");
      expect(o.stderr()).toContain("model call failed");
      expect(bad.cacheFiles()).toEqual([]); // failures are never cached
    } finally {
      bad.restore(); // back to the outer setup's environment
    }
  });
});

describe("list", () => {
  test("prints id, date, prompts and edits", async () => {
    const r = await cli(["list"]);
    expect(r.code).toBe(0);
    expect(normalize(r.out)).toContain("abcdef12  DATE TIME");
    expect(r.out).toMatch(/abcdef12 .* 2 {6}4\n/);
    expect(r.out).toContain("offscript review <id>");
    const j = JSON.parse((await cli(["list", "--json", "--limit", "5"])).out);
    expect(j).toMatchObject({ schemaVersion: 1, sessions: [{ id: t.fx.sessionId, prompts: 2, edits: 4 }] });
  });
});

describe("environment", () => {
  test("without the Claude Code CLI the review uses the heuristic ledger and says so", async () => {
    const none = setup({ claude: false });
    try {
      const o = makeIo(none.fx.repo);
      expect(await run(["review", "--json", "--fail-on", "never"], o.io)).toBe(0);
      expect(JSON.parse(o.stdout()).ledger.source).toBe("heuristic");
      expect(o.stderr()).toContain("Claude Code CLI not found");
      const hook = makeIo(none.fx.repo, { stdin: JSON.stringify({ cwd: none.fx.repo, transcript_path: none.fx.transcript }) });
      expect(await run(["review", "--hook"], hook.io)).toBe(0);
      expect(hook.stderr()).toBe("");
      expect(hook.stdout().trimEnd().split("\n").length).toBe(1);
    } finally {
      none.restore();
    }
  });

  test("a terminal sees a progress line on stderr that is cleared at the end", async () => {
    const o = makeIo(repo, { tty: true });
    o.io.errIsTTY = true;
    expect(await run(["review", "--no-llm", "--fail-on", "never"], o.io)).toBe(0);
    expect(o.stderr()).toBe("offscript: reviewing...\r\x1b[2K\r");
  });

  test("two sessions can share a prefix", async () => {
    const copy = join(dirname(t.fx.transcript), "abcdef12-0000-4000-8000-000000000000.jsonl");
    writeFileSync(copy, readFileSync(t.fx.transcript, "utf8").replaceAll(t.fx.sessionId, "abcdef12-0000-4000-8000-000000000000"));
    try {
      const r = await cli(["review", "--no-llm", "abcdef12"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("matches 2 sessions");
    } finally {
      rmSync(copy);
    }
  });

  test("realIo reads the process", () => {
    const io = realIo();
    expect(io.cwd).toBe(process.cwd());
    expect(typeof io.outIsTTY).toBe("boolean");
    expect(typeof io.readStdin).toBe("function");
  });

  test("runs as a script", () => {
    const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "main.ts"), "--help"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage");
  });
});

describe("failure handling", () => {
  test("an unexpected error exits 4 with one line, never 1 (problems) and never a stack trace", async () => {
    const o = makeIo(repo);
    o.io.out = () => {
      throw new Error("EPIPE: broken pipe");
    };
    expect(await run(["review", "--no-llm"], o.io)).toBe(4);
    expect(o.stderr()).toBe("offscript: unexpected failure: EPIPE: broken pipe\n");
  });

  test("no progress line on a dumb terminal, one on a real one", async () => {
    for (const [env, expected] of [
      [{ TERM: "dumb" }, false],
      [{ TERM: "xterm" }, true],
    ] as const) {
      const o = makeIo(repo, { env });
      o.io.errIsTTY = true;
      await run(["review", "--no-llm"], o.io);
      expect(o.stderr().includes("\x1b[2K")).toBe(expected);
    }
  });
});
