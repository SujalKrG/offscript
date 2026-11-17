// Regression tests from the review of the Agent Trace export.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseUnifiedDiff } from "../src/git.ts";
import { validateTraceRecord } from "../src/trace-validate.ts";
import { linesOf, World } from "./trace-world.ts";

const A = "const alpha = computeAlpha(1);";
const B = "const beta = computeBeta(2);";

describe("evidence rule", () => {
  test("an edit that wrote a line once does not explain a second copy of it", () => {
    const w = new World();
    w.write("a.ts", [A, "// typed by a human", A]);
    w.session("s1").create("a.ts", [A]).done();
    w.commit();
    const { records, summary } = w.export("s1");
    expect([...linesOf(records[0]!).get("a.ts")!]).toEqual([1]);
    expect(summary.unresolvedLines).toBe(2);
  });

  test("a blank line the edit did not write is not credited, one it wrote is", () => {
    const w = new World();
    w.write("a.ts", [A, "", "", B]);
    w.session("s1").create("a.ts", [A, B]).done();
    w.commit();
    expect([...linesOf(w.export("s1").records[0]!).get("a.ts")!]).toEqual([1, 4]);

    const v = new World();
    v.write("a.ts", [A, "", B]);
    v.session("s1").create("a.ts", [A, "", B]).done();
    v.commit();
    expect([...linesOf(v.export("s1").records[0]!).get("a.ts")!]).toEqual([1, 2, 3]);
  });

  test("identical text added by two commits is credited to the first commit only", () => {
    const w = new World();
    w.write("a.ts", [A]);
    w.session("s1").create("a.ts", [A]).done();
    const c1 = w.commit("c1");
    w.write("a.ts", []);
    w.commit("c2");
    w.write("a.ts", [A]);
    w.commit("c3");
    const { records } = w.export("s1");
    expect(records.map((r) => r.vcs.revision)).toEqual([c1]);
  });

  test("a rename in a later commit does not lend the old file's edits to an earlier commit", () => {
    const w = new World();
    w.write("a.ts", [B]);
    w.session("s1").create("a.ts", [A, B]).create("b.ts", ["const gamma = computeGamma(3);"]).done();
    w.write("b.ts", [A]); // a human typed the text the session wrote into a.ts
    const c1 = w.commit("c1");
    w.remove("b.ts");
    w.commit("c2");
    w.move("a.ts", "b.ts");
    const c3 = w.commit("c3");
    expect(w.git("show", "--name-status", "-M", c3)).toContain("R100");
    const { records } = w.export("s1");
    expect(records.find((r) => r.vcs.revision === c1)?.files.some((f) => f.path === "b.ts")).toBeFalsy();
  });
});

describe("git diff parsing", () => {
  test("a removed line that starts with '-- ' is content, not a file header", () => {
    const d = parseUnifiedDiff(
      ["diff --git a/q.sql b/q.sql", "--- a/q.sql", "+++ b/q.sql", "@@ -1 +1 @@", "--- old comment", "+select 20;", "@@ -5,0 +6,2 @@", "+++ added", "+x"].join(
        "\n",
      ),
    );
    expect(d[0]!.oldPath).toBe("q.sql");
    expect(d[0]!.path).toBe("q.sql");
    expect(d[0]!.removed.map((l) => l.text)).toEqual(["-- old comment"]);
    expect(d[0]!.added.map((l) => [l.newLineNo, l.text])).toEqual([
      [1, "select 20;"],
      [6, "++ added"],
      [7, "x"],
    ]);
  });

  test("a path with a space loses the tab git appends", () => {
    const w = new World();
    w.write("my file.ts", [A]);
    w.session("s1").create("my file.ts", [A]).done();
    w.commit();
    const { records } = w.export("s1");
    expect(records[0]!.files[0]!.path).toBe("my file.ts");
  });
});

describe("performance", () => {
  test("thousands of identical trivial lines finish fast and stay unresolved", () => {
    const w = new World();
    const lines = Array.from({ length: 3000 }, () => "});");
    w.write("big.ts", lines);
    w.session("s1").create("big.ts", lines).done();
    w.commit();
    const t = performance.now();
    const { records, summary } = w.export("s1");
    expect(performance.now() - t).toBeLessThan(4000); // was about 50 s (cubic) before the pre-check and the work budget
    expect(records).toEqual([]);
    expect(summary.unresolvedLines).toBe(3000);
  });
});

// biome-ignore lint/suspicious/noExplicitAny: the tests edit records into shapes the types forbid
type Loose = any;

describe("validator against the published schema", () => {
  const base = () => ({
    version: "0.1",
    id: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-11-18T00:00:00Z",
    files: [{ path: "a", conversations: [{ ranges: [{ start_line: 1, end_line: 2 }] }] }],
  });
  const bad = (edit: (r: Loose) => void) => {
    const r: Loose = base();
    edit(r);
    return validateTraceRecord(r).length > 0;
  };

  test("a valid record passes", () => expect(validateTraceRecord(base())).toEqual([]));

  test("fields named like Object.prototype members are unknown fields", () => {
    for (const k of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(bad((r) => Object.defineProperty(r, k, { value: 1, enumerable: true }))).toBe(true);
      expect(bad((r) => Object.defineProperty(r.files[0], k, { value: 1, enumerable: true }))).toBe(true);
      expect(bad((r) => Object.defineProperty(r.files[0].conversations[0].ranges[0], k, { value: 1, enumerable: true }))).toBe(true);
    }
  });

  test("an undefined required field counts as missing, an undefined extra field is ignored", () => {
    expect(bad((r) => (r.id = undefined))).toBe(true);
    expect(bad((r) => (r.junk = undefined))).toBe(false);
  });

  test("date-time needs a real calendar date and clock", () => {
    for (const t of [
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-02-01T24:00:00Z",
      "2026-02-01T10:60:00Z",
      "2026-02-01T10:00:00",
      "2026-02-01 10:00:00Z",
    ])
      expect(bad((r) => (r.timestamp = t))).toBe(true);
    for (const t of ["2028-02-29T00:00:00Z", "2026-11-18T10:00:00.123+05:30"]) expect(bad((r) => (r.timestamp = t))).toBe(false);
  });

  test("uri refuses characters RFC 3986 does not allow", () => {
    const withUrl = (u: string) => bad((r) => (r.files[0].conversations[0].url = u));
    expect(withUrl("https://x.y/<z>")).toBe(true);
    expect(withUrl("https://x.y/a b")).toBe(true);
    expect(withUrl("https://x.y/%zz")).toBe(true);
    expect(withUrl("no-scheme")).toBe(true);
    expect(withUrl("https://x.y/a%20b?q=1#f")).toBe(false);
  });

  test("maxLength counts characters, not UTF-16 units; whole numbers written as 1.0 are integers", () => {
    const model = (m: string) => bad((r) => (r.files[0].conversations[0].contributor = { type: "ai", model_id: m }));
    expect(model("\u{1F600}".repeat(250))).toBe(false);
    expect(model("\u{1F600}".repeat(251))).toBe(true);
    expect(bad((r) => (r.files[0].conversations[0].ranges[0].start_line = 1.0))).toBe(false);
    expect(bad((r) => (r.files[0].conversations[0].ranges[0].start_line = 1.5))).toBe(true);
  });

  test("an over-long model name is left out of the record instead of failing the export", () => {
    const w = new World();
    w.write("a.ts", [A]);
    w.session("s1").create("a.ts", [A], "m".repeat(300)).done();
    w.commit();
    const { records } = w.export("s1");
    expect(records[0]!.files[0]!.conversations[0]!.contributor).toEqual({ type: "ai" });
    expect(validateTraceRecord(records[0])).toEqual([]);
  });
});

describe("odd files and commits", () => {
  test("CRLF without a final newline, a binary file, a deleted file, a rename with an edit, an empty commit and a mode-only commit", () => {
    const w = new World();
    const C = "const gamma = computeGamma(3);";
    writeFileSync(join(w.repo, "crlf.ts"), `${A}\r\n${B}\r\n${C}`);
    writeFileSync(join(w.repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    w.write("old.ts", ["// header", A, B, C]);
    w.write("gone.ts", [A]);
    w.session("s1").create("crlf.ts", [A, B, C]).create("bin.dat", ["x"]).create("old.ts", [A, B, C]).create("gone.ts", [A]).done();
    const c1 = w.commit("c1");
    w.remove("gone.ts");
    w.move("old.ts", "new.ts");
    w.write("new.ts", ["// header changed", A, B, C]);
    w.session("s1")
      .create("crlf.ts", [A, B, C])
      .create("bin.dat", ["x"])
      .create("old.ts", [A, B, C])
      .create("gone.ts", [A])
      .edit("new.ts", ["// header changed"])
      .done();
    const c2 = w.commit("c2");
    w.commit("empty");
    w.git("update-index", "--chmod=+x", "crlf.ts");
    w.commit("mode only");
    const { records } = w.export("s1");
    expect(records.map((r) => r.vcs.revision)).toEqual([c1, c2]);
    const at = (r: (typeof records)[number]) => Object.fromEntries([...linesOf(r)].map(([p, s]) => [p, [...s]]));
    expect(at(records[0]!)).toEqual({ "crlf.ts": [1, 2, 3], "gone.ts": [1], "old.ts": [2, 3, 4] });
    expect(at(records[1]!)).toEqual({ "new.ts": [1] });
    for (const r of records) expect(validateTraceRecord(r)).toEqual([]);
    // round trip: the credited lines really are at those numbers in that commit
    expect(w.show(c2, "new.ts")[0]).toBe("// header changed");
  });
});
