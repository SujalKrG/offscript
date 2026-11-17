import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateTraceRecord } from "../../core/src/trace-validate.ts";
import { World } from "../../core/test/trace-world.ts";
import { SCHEMA_VERSION } from "../src/json.ts";
import { run, USAGE } from "../src/main.ts";
import { emptyDir, makeIo, setup } from "./helpers.ts";

const OPUS = "claude-opus-4-1";
const lines = ["export const first = compute(1);", "export const second = compute(2);", "export const third = compute(3);"];

/** A repo with one committed agent session; `config` is the CLAUDE_CONFIG_DIR that finds it. */
function committedWorld(model = OPUS) {
  const w = new World();
  w.write("src/a.ts", lines);
  w.write("src/b.ts", ["export const other = compute(9);"]);
  w.session("aaaa1111-session").create("src/a.ts", lines, model).done();
  w.session("aaaa2222-session").create("src/b.ts", ["export const other = compute(9);"], model).done();
  const sha = w.commit("work");
  return { w, sha, config: dirname(w.projects) };
}

async function cli(cwd: string, config: string, args: string[]) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  const o = makeIo(cwd);
  let code: number;
  try {
    code = await run(args, o.io);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
  return { code, out: o.stdout(), err: o.stderr() };
}

/** Every file under .git with its size, so a write of any kind shows up. */
function gitListing(repo: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${p}:${statSync(p).size}`);
    }
  };
  walk(join(repo, ".git"));
  return out.sort();
}

describe("export", () => {
  const t = committedWorld();

  test("stdout is only the JSON array; the summary goes to stderr", async () => {
    const r = await cli(t.w.repo, t.config, ["export", "aaaa1111"]);
    expect(r.code).toBe(0);
    const records = JSON.parse(r.out);
    expect(records.length).toBe(1);
    expect(records[0].vcs).toEqual({ type: "git", revision: t.sha });
    expect(validateTraceRecord(records[0])).toEqual([]);
    expect(records[0].files[0].path).toBe("src/a.ts");
    expect(records[0].files[0].conversations[0].ranges).toEqual([{ start_line: 1, end_line: 3 }]);
    expect(records[0].files[0].conversations[0].contributor.model_id).toBe(`anthropic/${OPUS}`);
    expect(r.out.endsWith("]\n")).toBe(true);
    expect(r.err).toContain("1 record(s) for session aaaa1111");
    expect(r.err).toContain("3 line(s) credited, 0 unresolved");
    expect(r.err).not.toContain("uncommitted");
  });

  test("--repo works from another directory and the prefix picks the session", async () => {
    const r = await cli(emptyDir("elsewhere"), t.config, ["export", "aaaa2222", "--repo", t.w.repo]);
    expect(r.code).toBe(0);
    const records = JSON.parse(r.out);
    expect(records.length).toBe(1);
    expect(records[0].files[0].path).toBe("src/b.ts");
  });

  test("--out writes <sha>.json atomically, prints nothing on stdout, and never touches .git", async () => {
    const before = gitListing(t.w.repo);
    const dir = join(emptyDir("traces"), "nested");
    const r = await cli(t.w.repo, t.config, ["export", "aaaa1111", "--out", dir]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(readdirSync(dir)).toEqual([`${t.sha}.json`]);
    const record = JSON.parse(readFileSync(join(dir, `${t.sha}.json`), "utf8"));
    expect(validateTraceRecord(record)).toEqual([]);
    expect(record.vcs.revision).toBe(t.sha);
    expect(r.err).toContain("wrote 1 file(s)");
    expect(gitListing(t.w.repo)).toEqual(before);
    // Re-running replaces the file in place and leaves no temporary files behind.
    expect((await cli(t.w.repo, t.config, ["export", "aaaa1111", "--out", dir])).code).toBe(0);
    expect(readdirSync(dir)).toEqual([`${t.sha}.json`]);
  });

  test("--out inside .git is refused", async () => {
    const before = gitListing(t.w.repo);
    const r = await cli(t.w.repo, t.config, ["export", "--out", join(t.w.repo, ".git", "traces")]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("must not be inside a .git directory");
    expect(existsSync(join(t.w.repo, ".git", "traces"))).toBe(false);
    expect(gitListing(t.w.repo)).toEqual(before);
  });

  test("exit codes: ambiguous prefix and unknown option are usage errors, an unknown session is 3, no repo is 2", async () => {
    const amb = await cli(t.w.repo, t.config, ["export", "aaaa"]);
    expect(amb.code).toBe(2);
    expect(amb.err).toContain("matches 2 sessions");
    expect((await cli(t.w.repo, t.config, ["export", "--bogus"])).code).toBe(2);
    expect((await cli(t.w.repo, t.config, ["export", "one", "two"])).code).toBe(2);
    const none = await cli(t.w.repo, t.config, ["export", "zzzz"]);
    expect(none.code).toBe(3);
    expect(none.err).toContain('no session starting with "zzzz"');
    expect(none.out).toBe("");
    const notRepo = await cli(emptyDir("plain"), t.config, ["export"]);
    expect(notRepo.code).toBe(2);
    expect(notRepo.err).toContain("not a git repository");
  });

  test("a repo with no sessions: exit 3, nothing on stdout", async () => {
    const w = new World();
    w.write("x.ts", ["const nothing = compute(0);"]);
    w.commit();
    const r = await cli(w.repo, dirname(w.projects), ["export"]);
    expect(r.code).toBe(3);
    expect(r.out).toBe("");
    expect(r.err).toContain("no Claude Code session with edits found");
  });

  test("a model name too long for the schema is left out of the record and the export still works", async () => {
    const long = committedWorld("x".repeat(300));
    const r = await cli(long.w.repo, long.config, ["export", "aaaa1111"]);
    expect(r.code).toBe(0);
    const records = JSON.parse(r.out);
    expect(records[0].files[0].conversations[0].contributor).toEqual({ type: "ai" });
    expect(validateTraceRecord(records[0])).toEqual([]);
  });

  test("--out is refused in every spelling of the .git folder: case, trailing dot, .., a link to it, and no file appears", async () => {
    const before = gitListing(t.w.repo);
    const git = join(t.w.repo, ".git");
    const via = emptyDir("via");
    const link = join(via, "innocent");
    symlinkSync(git, link, "junction");
    const spellings = [
      join(t.w.repo, ".GIT", "traces"),
      join(t.w.repo, ".git.", "traces"),
      join(t.w.repo, "src", "..", ".git", "x"),
      git,
      join(git, "hooks"),
      join(link, "traces"),
      link,
    ];
    for (const out of spellings) {
      const r = await cli(t.w.repo, t.config, ["export", "aaaa1111", "--out", out]);
      expect([out, r.code]).toEqual([out, 2]);
      expect(r.out).toBe("");
    }
    rmSync(link); // removes the junction only, never what it points to
    expect(existsSync(join(git, "traces"))).toBe(false);
    expect(gitListing(t.w.repo)).toEqual(before);
    // a folder that only has "git" in its name is fine
    const ok = await cli(t.w.repo, t.config, ["export", "aaaa1111", "--out", join(emptyDir("fine"), "my.github")]);
    expect(ok.code).toBe(0);
  });

  test("a failed write leaves no temporary file", async () => {
    const dir = emptyDir("blocked");
    mkdirSync(join(dir, `${t.sha}.json`)); // a folder where the file must go: the rename fails
    const r = await cli(t.w.repo, t.config, ["export", "aaaa1111", "--out", dir]);
    expect(r.code).toBe(4);
    expect(readdirSync(dir)).toEqual([`${t.sha}.json`]);
  });

  test("USAGE documents export and the MIME type, and list --json reports the shared schema version", () => {
    expect(USAGE).toContain("offscript export [session-id-prefix]");
    expect(USAGE).toContain("application/vnd.agent-trace.record+json");
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe("export of uncommitted work", () => {
  const u = setup();
  afterAll(() => u.restore());

  test("nothing committed: an empty array on stdout, the skipped lines counted on stderr, exit 0", async () => {
    const r = await cli(u.fx.repo, dirname(u.fx.projects), ["export"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
    expect(r.err).toMatch(/\d+ uncommitted line\(s\) skipped/);
    expect(r.err).toContain("0 record(s)");
  });

  test("list --json carries the shared schemaVersion", async () => {
    const r = await cli(u.fx.repo, dirname(u.fx.projects), ["list", "--json"]);
    expect(JSON.parse(r.out).schemaVersion).toBe(SCHEMA_VERSION);
  });
});
