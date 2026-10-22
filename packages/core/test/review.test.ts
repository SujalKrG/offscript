import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cacheDir, cacheKey, getCached, putCached } from "../src/cache.ts";
import { parseSession } from "../src/ingest/claude-code.ts";
import { cachedIntentLedger, heuristicLedger, isFollowUp } from "../src/intent.ts";
import { runClaudeJson, spawnTarget } from "../src/judge/claude-cli.ts";
import { openRepo, reviewSession } from "../src/review.ts";
import type { Session } from "../src/types.ts";
import { buildFixture, claudeCalls, fakeClaude } from "./fixture.ts";

const fx = buildFixture();
const work = mkdtempSync(join(tmpdir(), "offscript-core-"));
const saved = { bin: process.env.OFFSCRIPT_CLAUDE_BIN, cache: process.env.OFFSCRIPT_CACHE_DIR, cfg: process.env.CLAUDE_CONFIG_DIR };
const cache = join(work, "cache");
process.env.OFFSCRIPT_CACHE_DIR = cache;
process.env.OFFSCRIPT_CLAUDE_BIN = fakeClaude(work);
afterAll(() => {
  for (const [k, v] of [
    ["OFFSCRIPT_CLAUDE_BIN", saved.bin],
    ["OFFSCRIPT_CACHE_DIR", saved.cache],
    ["CLAUDE_CONFIG_DIR", saved.cfg],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("cache", () => {
  test("directory choice: override, XDG, LOCALAPPDATA, home", () => {
    expect(cacheDir({ OFFSCRIPT_CACHE_DIR: "/o", XDG_CACHE_HOME: "/x" }, "linux", "/h")).toBe("/o");
    expect(cacheDir({ XDG_CACHE_HOME: "/x" }, "linux", "/h")).toBe(join("/x", "offscript"));
    expect(cacheDir({ LOCALAPPDATA: "C:\\L" }, "win32", "/h")).toBe(join("C:\\L", "offscript"));
    expect(cacheDir({}, "linux", "/h")).toBe(join("/h", ".cache", "offscript"));
    expect(cacheDir({}, "win32", "/h")).toBe(join("/h", ".cache", "offscript"));
  });

  test("round trip, atomic write, bad keys and corrupt files are misses", () => {
    const key = cacheKey("a", "b");
    expect(cacheKey("a", "b")).toBe(key);
    expect(cacheKey("ab", "")).not.toBe(key); // part boundaries matter
    expect(getCached(key)).toBeNull();
    expect(putCached(key, { n: 1 })).toBe(true);
    expect(getCached(key)).toEqual({ n: 1 });
    expect(readdirSync(cache)).toEqual([`${key}.json`]); // no tmp files left behind
    expect(putCached("../escape", 1)).toBe(false);
    expect(getCached("../escape")).toBeNull();
    writeFileSync(join(cache, `${"0".repeat(64)}.json`), "{ broken");
    expect(getCached("0".repeat(64))).toBeNull();
  });

  test("an unwritable cache is a miss, not an error", () => {
    const blocker = join(work, "file");
    writeFileSync(blocker, "x");
    const prev = process.env.OFFSCRIPT_CACHE_DIR;
    process.env.OFFSCRIPT_CACHE_DIR = join(blocker, "sub"); // a directory below a file
    try {
      expect(putCached(cacheKey("z"), 1)).toBe(false);
    } finally {
      process.env.OFFSCRIPT_CACHE_DIR = prev;
    }
  });
});

describe("cached intent ledger", () => {
  test("hits skip claude; a changed prompt, a missing final message or a failed call miss or are not stored", () => {
    const s = parseSession(fx.transcript);
    const before = claudeCalls(work);
    const a = cachedIntentLedger(s, fx.repo);
    expect(a.hit).toBe(false);
    expect(claudeCalls(work)).toBe(before + 1);
    const b = cachedIntentLedger(s, fx.repo);
    expect(b.hit).toBe(true);
    expect(claudeCalls(work)).toBe(before + 1);
    expect(b.ledger.intents).toEqual(a.ledger.intents);
    expect(b.ledger.backend).toContain("cached");
    expect(b.ledger.costUsd).toBeNull();
    const changed: Session = { ...s, prompts: s.prompts.map((p, i) => (i === 0 ? { ...p, text: `${p.text} Also add a README.` } : p)) };
    expect(cachedIntentLedger(changed, fx.repo).hit).toBe(false);
    expect(claudeCalls(work)).toBe(before + 2);
    // a session with no prompts never reaches the model
    expect(cachedIntentLedger({ ...s, prompts: [] }, fx.repo).ledger.notes).toContain("no human prompts");
    expect(claudeCalls(work)).toBe(before + 2);
  });

  test("a damaged entry is a miss", () => {
    const s = parseSession(fx.transcript);
    for (const f of readdirSync(cache))
      writeFileSync(join(cache, f), JSON.stringify({ intents: [{ text: "ok", kind: "weird" }], claims: "no", confidence: "??" }));
    const r = cachedIntentLedger(s, fx.repo);
    expect(r.hit).toBe(true); // sanitised, not trusted
    expect(r.ledger.intents[0]).toMatchObject({ id: "I1", kind: "task", status: "active" });
    expect(r.ledger.claims).toEqual([]);
    expect(r.ledger.confidence).toBe("low");
  });
});

describe("heuristic ledger", () => {
  const fake = (texts: string[]): Session => ({
    ...parseSession(fx.transcript),
    prompts: texts.map((text, i) => ({ index: i + 1, uuid: `u${i}`, timestamp: "", text })),
  });

  test("one request per prompt that is not a follow-up, and nothing is spawned", () => {
    const before = claudeCalls(work);
    const texts = [
      "Add a dark mode toggle to settings. Use the existing theme tokens.",
      "yes",
      "go ahead",
      "Yes, do it please!",
      "Don't touch the auth module",
      "ok",
      "also rename Foo to Bar in api.ts",
      "continue",
      "",
    ];
    const l = heuristicLedger(fake(texts));
    expect(l.intents.map((i) => [i.id, i.kind, i.sourcePrompts])).toEqual([
      ["I1", "task", [1]],
      ["I2", "constraint", [5]],
      ["I3", "task", [7]],
    ]);
    expect(l.intents[0]!.text).toBe("Add a dark mode toggle to settings.");
    expect(l.intents[0]!.quote.length).toBeLessThanOrEqual(120);
    expect(l.backend).toBe("heuristic");
    expect(l.error).toBeNull();
    expect(claudeCalls(work)).toBe(before);
    expect(heuristicLedger(fake(["x".repeat(400)])).intents[0]!.text.length).toBe(160);
  });

  test("harness and meta prompts are not requests", () => {
    const l = heuristicLedger(
      fake([
        "[Request interrupted by user for tool use]",
        "[Request interrupted by user]",
        "<command-name>/clear</command-name>",
        "Caveat: The messages below were generated by the user while running local commands.",
        "<local-command-stdout>ok</local-command-stdout>",
        "Fix the cart total",
      ]),
    );
    expect(l.intents.map((i) => [i.id, i.text, i.sourcePrompts])).toEqual([["I1", "Fix the cart total", [6]]]);
  });

  test("follow-up detection", () => {
    for (const t of ["yes", "Go ahead.", "ok, continue", "sounds good!", "lgtm", "  "]) expect(isFollowUp(t)).toBe(true);
    for (const t of ["yes but add tests", "continue with the migration", "fix it", "no"]) expect(isFollowUp(t)).toBe(false);
  });
});

describe("reviewSession", () => {
  process.env.CLAUDE_CONFIG_DIR = dirname(fx.projects);
  const ctx = openRepo(fx.repo)!;
  const session = ctx.getSession(ctx.refs[0]!.path)!;

  test("opens a repo, or says it is not one", () => {
    expect(ctx.root).toBe(fx.repo);
    expect(ctx.refs.map((r) => r.id)).toEqual([fx.sessionId]);
    expect(openRepo(mkdtempSync(join(tmpdir(), "offscript-nogit-")))).toBeNull();
    expect(ctx.getSession("/no/such/file.jsonl")).toBeNull();
  });

  test("ledger modes", async () => {
    const none = await reviewSession({ ctx, session, ledger: "none" });
    expect(none.ledgerSource).toBe("none");
    expect(none.verdicts).toBeNull();
    expect(none.markdown).toContain("_No intents extracted._");
    const heur = await reviewSession({ ctx, session, ledger: "heuristic" });
    expect(heur.ledgerSource).toBe("heuristic");
    expect(heur.verdicts?.verdicts.length).toBe(2);
    expect(heur.claims).not.toBeNull();
    const fresh = await reviewSession({ ctx, session, ledger: "model" });
    expect(fresh.ledgerSource).toBe("model");
    expect(fresh.report.ledger.intents.map((i) => i.id)).toEqual(["I1", "I2"]);
    let started = 0;
    const cached = await reviewSession({ ctx, session, ledger: "cached", onLedgerStart: () => started++ });
    expect(started).toBe(1);
    expect(cached.ledgerSource).toBe("cache");
    expect(cached.flags.get("src/auth/session.ts")).toContain("against-instruction");
  });

  test("a bad base ref is reported in the result, not thrown", async () => {
    const r = await reviewSession({ ctx, session, ledger: "none", base: "no-such-ref", head: "also-missing" });
    expect(r.report.error).not.toBeNull();
    expect(r.markdown).toContain("- Error:");
  });
});

describe("spike script", () => {
  test("still prints its summary line and writes the report", () => {
    const out = join(work, "spike-out");
    const r = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "spike.ts"), "--repo", fx.repo, "--out", out], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: dirname(fx.projects) },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("- abcdef12: 2 prompts, 4 edits, 2 intents, traced 89%");
    expect(r.stdout).toContain("1 session report(s) written to");
    const day = JSON.parse(readFileSync(fx.transcript, "utf8").split("\n")[1]!).timestamp.slice(0, 10);
    expect(existsSync(join(out, "shop", `${day}-abcdef12.md`))).toBe(true);
    expect(existsSync(join(out, "shop", "summary.md"))).toBe(true);
    const nollm = spawnSync(process.execPath, [join(import.meta.dir, "..", "src", "spike.ts"), "--repo", fx.repo, "--out", out, "--no-llm"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: dirname(fx.projects) },
    });
    expect(nollm.stdout).toContain("0 intents");
  });
});

describe("claude cli safety", () => {
  const saved = process.env.OFFSCRIPT_CLAUDE_BIN;
  afterAll(() => {
    if (saved === undefined) delete process.env.OFFSCRIPT_CLAUDE_BIN;
    else process.env.OFFSCRIPT_CLAUDE_BIN = saved;
  });

  test("a timeout stops at the first attempt instead of retrying with fewer flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "offscript-to-"));
    process.env.OFFSCRIPT_CLAUDE_BIN = fakeClaude(dir, { hangMs: 5000 });
    const started = Date.now();
    const r = runClaudeJson({ system: "s", input: "i", timeoutMs: 400 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out");
    expect(claudeCalls(dir)).toBe(1);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("model errors are redacted before they can reach the terminal, JSON or a report", () => {
    const dir = mkdtempSync(join(tmpdir(), "offscript-red-"));
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789";
    process.env.OFFSCRIPT_CLAUDE_BIN = fakeClaude(dir, { fail: true, errorText: `bad request for key ${secret}` });
    const r = runClaudeJson({ system: "s", input: "i" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("REDACTED");
    expect(r.error).not.toContain(secret);
  });

  test("a claude.cmd path with spaces is quoted for cmd.exe, a plain binary is not", () => {
    expect(spawnTarget({ cmd: "C:\\Users\\Jo Smith\\npm\\claude.cmd", shell: true })).toBe('"C:\\Users\\Jo Smith\\npm\\claude.cmd"');
    expect(spawnTarget({ cmd: "claude", shell: false })).toBe("claude");
  });
});
