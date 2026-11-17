import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionChange } from "../src/git.ts";
import { parseSession } from "../src/ingest/claude-code.ts";
import { buildCreditIndex, creditFile, isTrivialLine } from "../src/provenance.ts";
import { openRepo } from "../src/review.ts";
import { buildTraceRecords, METADATA_KEY, TRACE_VERSION } from "../src/trace.ts";
import { type Schema, TRACE_SCHEMA, validateTraceRecord } from "../src/trace-validate.ts";
import { buildFixture } from "./fixture.ts";
import { linesOf, World } from "./trace-world.ts";

const OPUS = "claude-opus-4-1";
const SONNET = "claude-sonnet-4-5";
const names = (r: { conversations: { ranges: { start_line: number; end_line: number }[] }[] }) => r.conversations.map((c) => c.ranges);

describe("ingest: message.model", () => {
  test("edits keep the model of the assistant turn that made them, subagent edits too", () => {
    const fx = buildFixture({ subagent: true });
    const s = parseSession(fx.transcript);
    expect(s.edits.length).toBeGreaterThan(0);
    for (const e of s.edits.filter((x) => !x.subagent)) expect(e.model).toBe("claude-opus-4-1");
    expect(s.edits.find((x) => x.subagent)?.model).toBe("claude-haiku-4-5");
  });

  test("a transcript with no model leaves it unset; placeholder models are ignored", () => {
    const w = new World();
    w.write("a.ts", ["const something = 1;"]);
    w.session("s1").create("a.ts", ["const something = 1;"]).done();
    const s = parseSession(join(w.projects, w.repo.replace(/[^A-Za-z0-9]/g, "-"), "s1.jsonl"));
    expect(s.edits[0]!.model).toBeUndefined();
    const raw = readFileSync(join(w.projects, w.repo.replace(/[^A-Za-z0-9]/g, "-"), "s1.jsonl"), "utf8").replace(
      /"role":"assistant"/,
      '"role":"assistant","model":"<synthetic>"',
    );
    writeFileSync(join(w.projects, w.repo.replace(/[^A-Za-z0-9]/g, "-"), "s2.jsonl"), raw);
    expect(parseSession(join(w.projects, w.repo.replace(/[^A-Za-z0-9]/g, "-"), "s2.jsonl")).edits[0]!.model).toBeUndefined();
  });
});

describe("git: per-commit added lines", () => {
  test("each commit keeps its own post-image line numbers; the net diff is unchanged", () => {
    const w = new World();
    w.write("a.ts", ["const one = compute(1);", "const two = compute(2);"]);
    w.session("s1").create("a.ts", ["const one = compute(1);", "const two = compute(2);"], OPUS).done();
    const c1 = w.commit("first");
    w.write("a.ts", ["const zero = compute(0);", "const one = compute(1);", "const two = compute(2);", "const three = compute(3);"]);
    w.session("s1")
      .create("a.ts", ["const one = compute(1);", "const two = compute(2);"], OPUS)
      .edit("a.ts", ["const zero = compute(0);", "const three = compute(3);"], [], OPUS)
      .done();
    const c2 = w.commit("second");
    const ctx = openRepo(w.repo, w.projects)!;
    const session = ctx.getSession(ctx.refs[0]!.path)!;
    const change = sessionChange(ctx.root, session)!;
    expect(change.commitDiffs.map((c) => c.sha)).toEqual([c1, c2]);
    expect(change.commitDiffs[0]!.files[0]!.added.map((l) => [l.newLineNo, l.text])).toEqual([
      [1, "const one = compute(1);"],
      [2, "const two = compute(2);"],
    ]);
    expect(change.commitDiffs[1]!.files[0]!.added.map((l) => [l.newLineNo, l.text])).toEqual([
      [1, "const zero = compute(0);"],
      [4, "const three = compute(3);"],
    ]);
    expect(change.uncommittedAddedLines).toBe(0);
    expect(change.files.length).toBe(1);
  });

  test("renames, deleted files and binary files; a cherry-picked copy is one commit", () => {
    const w = new World();
    const big = Array.from({ length: 12 }, (_, i) => `export const value${i} = compute(${i});`);
    w.write("old.ts", big);
    w.write("gone.ts", ["export const doomed = compute(99);"]);
    writeFileSync(join(w.repo, "img.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    w.session("s1").create("old.ts", big, OPUS).create("gone.ts", ["export const doomed = compute(99);"], OPUS).create("img.bin", ["x"], OPUS).done();
    w.commit("add");
    w.move("old.ts", "new.ts");
    w.remove("gone.ts");
    w.write("new.ts", [...big, "export const extra = compute(100);"]);
    w.session("s1")
      .create("old.ts", big, OPUS)
      .create("gone.ts", ["export const doomed = compute(99);"], OPUS)
      .create("img.bin", ["x"], OPUS)
      .edit("new.ts", ["export const extra = compute(100);"], [], OPUS)
      .done();
    w.commit("rename and delete");
    const ctx = openRepo(w.repo, w.projects)!;
    const change = sessionChange(ctx.root, ctx.getSession(ctx.refs[0]!.path)!)!;
    const second = change.commitDiffs[1]!.files;
    const renamed = second.find((f) => f.path === "new.ts")!;
    expect(renamed.status).toBe("renamed");
    expect(renamed.oldPath).toBe("old.ts");
    expect(renamed.added.map((l) => l.newLineNo)).toEqual([13]);
    expect(second.find((f) => f.path === "gone.ts")!.added).toEqual([]);
    expect(change.commitDiffs[0]!.files.find((f) => f.path === "img.bin")!.binary).toBe(true);

    // The same change cherry-picked onto another branch has the same patch-id: only one copy is kept.
    w.git("branch", "-q", "copy", "HEAD~1");
    w.write("extra.ts", ["export const unique = compute(7);"]);
    w.session("s1").create("extra.ts", ["export const unique = compute(7);"], OPUS).done();
    const c3 = w.commit("extra");
    w.git("checkout", "-q", "copy");
    w.git("cherry-pick", c3);
    const ctx2 = openRepo(w.repo, w.projects)!;
    const shas = sessionChange(ctx2.root, ctx2.getSession(ctx2.refs[0]!.path)!)!.commitDiffs.map((c) => c.sha);
    expect(new Set(shas).size).toBe(shas.length);
    expect(shas.filter((s) => w.git("show", "-s", "--format=%s", s).trim() === "extra").length).toBe(1);
  });
});

describe("matcher: runs, not single lines", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "offscript-match-")));
  const edit = (addedLines: string[], extra = {}) => ({
    seq: 1,
    afterPrompt: 1,
    toolUseId: "t",
    tool: "Edit",
    filePath: join(root, "a.ts"),
    addedLines,
    removedLines: [],
    kind: "update" as const,
    failed: false,
    model: OPUS,
    ...extra,
  });
  const index = (addedLines: string[]) => {
    const s = { id: "me", edits: [edit(addedLines)], turnDeltas: [] } as never;
    return buildCreditIndex(root, s, [root]);
  };
  const line = (n: number, text: string) => ({ file: "a.ts", newLineNo: n, text });

  test("a lone trivial line is never credited, but the same line inside a matched run is", () => {
    expect(isTrivialLine("}")).toBe(true);
    expect(isTrivialLine("});")).toBe(true);
    expect(isTrivialLine("const total = compute(1);")).toBe(false);
    const idx = index(["function run() {", "  const total = compute(1);", "}"]);
    const lone = creditFile(idx, ["a.ts"], [line(7, "}")]);
    expect(lone.credits.size).toBe(0);
    expect(lone.unresolved).toEqual([7]);
    const run = creditFile(idx, ["a.ts"], [line(1, "function run() {"), line(2, "  const total = compute(1);"), line(3, "}")]);
    expect([...run.credits.keys()]).toEqual([1, 2, 3]);
    expect(run.credits.get(1)!.model).toBe(OPUS);
  });

  test("a hunk that only partly matches credits the matching part and reports the rest", () => {
    const idx = index(["const alpha = compute(1);", "const beta = compute(2);"]);
    const r = creditFile(idx, ["a.ts"], [line(4, "const alpha = compute(1);"), line(5, "const beta = compute(2);"), line(6, "const human = typed(3);")]);
    expect([...r.credits.keys()]).toEqual([4, 5]);
    expect(r.unresolved).toEqual([6]);
  });

  test("interior blank lines ride with their neighbours, edge blanks do not", () => {
    const idx = index(["const alpha = compute(1);", "", "const beta = compute(2);"]);
    const r = creditFile(idx, ["a.ts"], [line(1, ""), line(2, "const alpha = compute(1);"), line(3, ""), line(4, "const beta = compute(2);"), line(5, "")]);
    expect([...r.credits.keys()].sort()).toEqual([2, 3, 4]);
    expect(r.unresolved).toEqual([]);
  });
});

describe("export", () => {
  test("credits only what an edit explains: ranges, model, unresolved human line, validates against the schema", () => {
    const w = new World();
    const a = ["export function area(w: number, h: number) {", "  const result = w * h;", "  return result;", "}"];
    w.write("src/a.ts", [...a.slice(0, 3), "// tweaked by hand later", a[3]!]);
    w.session("s1").prompt("write area()").create("src/a.ts", a, OPUS).done();
    const sha = w.commit("area");
    const { records, summary } = w.export("s1");
    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(validateTraceRecord(r)).toEqual([]);
    expect(r.version).toBe(TRACE_VERSION);
    expect(r.vcs).toEqual({ type: "git", revision: sha });
    expect(r.tool).toEqual({ name: "claude-code", version: "2.1.300" });
    expect(r.timestamp).toBe("2026-11-18T00:00:00.000Z");
    // The hand-written comment (line 4) is not credited; the closing brace after it is a lone trivial line.
    expect(names(r.files[0]!)).toEqual([[{ start_line: 1, end_line: 3 }]]);
    expect(r.files[0]!.conversations[0]!.contributor).toEqual({ type: "ai", model_id: `anthropic/${OPUS}` });
    const meta = r.metadata[METADATA_KEY] as Record<string, unknown>;
    expect(meta).toMatchObject({
      generator: "offscript",
      generator_version: "test",
      derivation: "transcript",
      session_id: "s1",
      unresolved_lines: 2,
      skipped_uncommitted_lines: 0,
    });
    expect(summary).toEqual({ commits: 1, files: 1, ranges: 1, creditedLines: 3, unresolvedLines: 2, skippedUncommittedLines: 0 });
    const json = JSON.stringify(r);
    expect(json).not.toContain(w.base);
    expect(json).not.toContain("write area");
    expect(json).not.toContain('"human"');
    expect(JSON.stringify(r)).not.toContain('"url"');
  });

  test("no model and no cli version: model_id and tool are left out", () => {
    const w = new World();
    w.write("a.ts", ["const something = compute(1);"]);
    w.session("s1", { version: null }).create("a.ts", ["const something = compute(1);"]).done();
    w.commit();
    const r = w.export("s1").records[0]!;
    expect(r.tool).toBeUndefined();
    expect(r.files[0]!.conversations[0]!.contributor).toEqual({ type: "ai" });
    expect(validateTraceRecord(r)).toEqual([]);
  });

  test("lines another session wrote are credited to that session's own conversation", () => {
    const w = new World();
    const mine = ["export const first = compute(1);", "export const second = compute(2);"];
    const theirs = ["export const third = compute(3);", "export const fourth = compute(4);"];
    w.write("shared.ts", [...mine, ...theirs]);
    w.session("mine").create("shared.ts", mine, OPUS).done();
    w.session("theirs").create("shared.ts", theirs, SONNET).done();
    w.commit();
    const r = w.export("mine").records[0]!;
    const f = r.files[0]!;
    expect(f.conversations.map((c) => c.contributor.model_id)).toEqual([`anthropic/${OPUS}`, `anthropic/${SONNET}`]);
    expect(names(f)).toEqual([[{ start_line: 1, end_line: 2 }], [{ start_line: 3, end_line: 4 }]]);
    const meta = r.metadata[METADATA_KEY] as { conversation_sessions: Record<string, string[]> };
    expect(meta.conversation_sessions["shared.ts"]).toEqual(["mine", "theirs"]);
    expect(validateTraceRecord(r)).toEqual([]);
  });

  test("a file changed in two models by one session gets one conversation per model", () => {
    const w = new World();
    w.write("a.ts", ["export const first = compute(1);", "export const second = compute(2);"]);
    w.session("s1").create("a.ts", ["export const first = compute(1);"], OPUS).edit("a.ts", ["export const second = compute(2);"], [], SONNET).done();
    w.commit();
    const f = w.export("s1").records[0]!.files[0]!;
    expect(f.conversations.map((c) => c.contributor.model_id)).toEqual([`anthropic/${OPUS}`, `anthropic/${SONNET}`]);
  });

  test("renames keep credit from edits made under the old name; deleted and binary files give no ranges", () => {
    const w = new World();
    const body = Array.from({ length: 12 }, (_, i) => `export const item${i} = compute(${i});`);
    w.write("old.ts", body);
    w.write("gone.ts", ["export const doomed = compute(99);"]);
    writeFileSync(join(w.repo, "img.bin"), Buffer.from([0, 1, 2, 0]));
    const s = w.session("s1").create("old.ts", body, OPUS).create("gone.ts", ["export const doomed = compute(99);"], OPUS).create("img.bin", ["x"], OPUS);
    s.done();
    const c1 = w.commit("add");
    // Rename, delete, and one more line the agent wrote under the old name before the move.
    w.session("s1")
      .create("old.ts", body, OPUS)
      .create("gone.ts", ["export const doomed = compute(99);"], OPUS)
      .create("img.bin", ["x"], OPUS)
      .edit("old.ts", ["export const late = compute(100);"], [], SONNET)
      .done();
    w.move("old.ts", "new.ts");
    w.write("new.ts", [...body, "export const late = compute(100);"]);
    w.remove("gone.ts");
    const c2 = w.commit("rename and delete");
    const { records } = w.export("s1");
    expect(records.map((r) => r.vcs.revision)).toEqual([c1, c2]);
    expect(records[0]!.files.map((f) => f.path)).toEqual(["gone.ts", "old.ts"]); // the binary file has nothing to credit
    expect(records[1]!.files.map((f) => f.path)).toEqual(["new.ts"]); // deleted file: no added lines
    expect(names(records[1]!.files[0]!)).toEqual([[{ start_line: 13, end_line: 13 }]]);
    expect(records[1]!.files[0]!.conversations[0]!.contributor.model_id).toBe(`anthropic/${SONNET}`);
    for (const r of records) expect(validateTraceRecord(r)).toEqual([]);
  });

  test("edits after the last commit are skipped and counted, not exported", () => {
    const w = new World();
    w.write("a.ts", ["export const first = compute(1);"]);
    w.session("s1")
      .create("a.ts", ["export const first = compute(1);"], OPUS)
      .edit("a.ts", ["export const later = compute(2);", "export const later2 = compute(3);"], [], OPUS)
      .done();
    w.write("a.ts", ["export const first = compute(1);"]);
    w.commit();
    w.write("a.ts", ["export const first = compute(1);", "export const later = compute(2);", "export const later2 = compute(3);"]);
    const { records, summary } = w.export("s1");
    expect(records.length).toBe(1);
    expect(summary.skippedUncommittedLines).toBe(2);
    expect(linesOf(records[0]!).get("a.ts")).toEqual(new Set([1]));
    expect((records[0]!.metadata[METADATA_KEY] as { skipped_uncommitted_lines: number }).skipped_uncommitted_lines).toBe(2);
  });

  test("a real fixture session, committed, exports a valid record", () => {
    const fx = buildFixture();
    const run = (...args: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: fx.repo, encoding: "utf8" });
    run("add", ".");
    run("commit", "-q", "-m", "agent work");
    const sha = run("rev-parse", "HEAD").stdout.trim();
    const ctx = openRepo(fx.repo, fx.projects)!;
    const session = ctx.getSession(ctx.refs[0]!.path)!;
    const change = sessionChange(ctx.root, session)!;
    const { records } = buildTraceRecords({ repoRoot: ctx.root, session, change, generatorVersion: "test", now: new Date("2026-11-18T00:00:00Z") });
    expect(records.length).toBe(1);
    expect(records[0]!.vcs.revision).toBe(sha);
    expect(validateTraceRecord(records[0]!)).toEqual([]);
    const byPath = linesOf(records[0]!);
    expect([...(byPath.get("src/cart.ts") ?? [])]).toEqual([1, 2, 3]);
    expect([...(byPath.get("src/coupon.ts") ?? [])]).toEqual([1, 2, 3]); // line 4 was typed by hand: not credited
    expect(byPath.has("README.md")).toBe(false);
    expect(records[0]!.files[0]!.conversations[0]!.contributor.model_id).toBe("anthropic/claude-opus-4-1");
  });
});

describe("vendored schema and validator", () => {
  test("the schema file is the one we pinned (update on purpose, with the README interpretation notes)", () => {
    const text = readFileSync(join(import.meta.dir, "..", "src", "trace-schema.json"), "utf8").replace(/\r\n/g, "\n");
    expect(createHash("sha256").update(text).digest("hex")).toBe("f86ded10e845445a21093283092752192b6c614093168035da93a47f696ca5eb");
  });

  let cached = "";
  const good = () => {
    if (!cached) {
      const w = new World();
      w.write("a.ts", ["const something = compute(1);"]);
      w.session("s1").create("a.ts", ["const something = compute(1);"], OPUS).done();
      w.commit();
      cached = JSON.stringify(w.export("s1").records[0]);
    }
    // biome-ignore lint/suspicious/noExplicitAny: the tests edit raw JSON freely
    return JSON.parse(cached) as any;
  };
  // biome-ignore lint/suspicious/noExplicitAny: the tests edit raw JSON freely
  const rejects = (mutate: (r: any) => void, needle: string) => {
    const r = good();
    mutate(r);
    const errors = validateTraceRecord(r);
    expect(errors.join("\n")).toContain(needle);
  };

  test("accepts our record and rejects the ways a record can be wrong", () => {
    expect(validateTraceRecord(good())).toEqual([]);
    rejects((r) => (r.version = "0.1.0"), "version: does not match");
    rejects((r) => (r.extra = 1), "extra: unknown field");
    rejects((r) => delete r.tool.version, "tool.version: required");
    rejects((r) => (r.files[0].conversations[0].ranges[0].start_line = 0), "start_line: below 1");
    rejects((r) => (r.files[0].conversations[0].ranges[0].end_line = 1.5), "end_line: expected an integer");
    rejects((r) => (r.files[0].conversations[0].contributor.type = "robot"), "contributor.type: must be one of");
    rejects((r) => (r.id = "not-a-uuid"), "id: not a valid uuid");
    rejects((r) => (r.timestamp = "yesterday"), "timestamp: not a valid date-time");
    rejects((r) => (r.files[0].conversations[0].url = "not a uri"), "url: not a valid uri");
    rejects((r) => (r.files[0].conversations[0].contributor.model_id = "x".repeat(251)), "model_id: longer than 250");
    rejects((r) => (r.files = {}), "files: expected an array");
    rejects((r) => (r.vcs = "git"), "vcs: expected an object");
    rejects((r) => (r.id = 5), "id: expected a string");
    rejects((r) => delete r.files, "files: required");
    rejects((r) => (r.vcs.type = "cvs"), "vcs.type: must be one of");
  });

  test("metadata takes anything; the validator refuses schema features it does not implement", () => {
    const r = good();
    r.metadata = { anything: [1, { a: null }] };
    expect(validateTraceRecord(r)).toEqual([]);
    expect(() => validateTraceRecord({}, { ...TRACE_SCHEMA, oneOf: [] } as Schema)).toThrow("unsupported schema keyword");
    expect(() => validateTraceRecord("x", { type: "string", format: "email" as never })).toThrow("unsupported format");
    expect(() => validateTraceRecord({}, { $ref: "#/nope" })).toThrow("unsupported $ref");
  });
});
