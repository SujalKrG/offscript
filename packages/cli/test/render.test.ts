import { afterAll, describe, expect, test } from "bun:test";
import { openRepo, type ReviewResult, reviewSession } from "../../core/src/review.ts";
import { detectTerm, renderTerminal } from "../src/render.ts";
import { type Problem, summarize } from "../src/summary.ts";
import { normalize, setup } from "./helpers.ts";

const t = setup();
afterAll(() => t.restore());

async function result(): Promise<ReviewResult> {
  const ctx = openRepo(t.fx.repo)!;
  return reviewSession({ ctx, session: ctx.getSession(ctx.refs[0]!.path)!, ledger: "heuristic" });
}

const problem = (i: number): Problem => ({
  mark: "warn",
  kind: "claim",
  id: null,
  text: `claim number ${i}`,
  detail: `stale: ${i} edits after the last test run`,
});

describe("renderTerminal", () => {
  test("Unicode view without colour", async () => {
    const r = await result();
    const out = normalize(renderTerminal(r, { color: false, unicode: true, full: false, reportPath: ".offscript/reports/x.md" }));
    expect(out.split("\n").slice(0, 6)).toEqual([
      "offscript  abcdef12  DATE TIME  2 requests, 4 edits, 89% traced",
      "",
      "  Did what you asked    ✔ 2 done",
      "  Only what you asked   ✘ 1 against your instructions",
      "  Told the truth        ✔ 1 claim verified",
      "",
    ]);
    expect(out).toContain("  Full report  .offscript/reports/x.md");
  });

  test("ASCII fallback under NO_COLOR, non-UTF-8 locales and pipes", () => {
    expect(detectTerm({ NO_COLOR: "1", LANG: "en_US.UTF-8" }, true, "linux")).toEqual({ color: false, unicode: false });
    expect(detectTerm({ LANG: "en_US.UTF-8" }, false, "linux")).toEqual({ color: false, unicode: false });
    expect(detectTerm({ LANG: "C" }, true, "linux")).toEqual({ color: true, unicode: false });
    expect(detectTerm({ LANG: "en_US.UTF-8", TERM: "dumb" }, true, "linux")).toEqual({ color: false, unicode: false });
    expect(detectTerm({ LANG: "en_US.utf8" }, true, "linux")).toEqual({ color: true, unicode: true });
    expect(detectTerm({ LC_ALL: "C", LANG: "en_US.UTF-8" }, true, "linux")).toEqual({ color: true, unicode: false });
    expect(detectTerm({ WT_SESSION: "x" }, true, "win32")).toEqual({ color: true, unicode: true });
    expect(detectTerm({}, true, "win32")).toEqual({ color: true, unicode: false });
    expect(detectTerm({ ConEmuANSI: "ON" }, true, "win32")).toEqual({ color: true, unicode: true });
    expect(detectTerm({ LANG: "en_US.UTF-8" }, true, "win32")).toEqual({ color: true, unicode: false });
  });

  test("problems are capped at 8 with a +N more line; --full shows all", async () => {
    const r = await result();
    const s = { ...summarize(r), problems: Array.from({ length: 11 }, (_, i) => problem(i + 1)) };
    const short = renderTerminal(r, { color: false, unicode: false, full: false, reportPath: null }, s);
    expect(short.match(/claim number/g)?.length).toBe(8);
    expect(short).toContain("+3 more (--full)");
    expect(short).not.toContain("Full report");
    const full = renderTerminal(r, { color: false, unicode: false, full: true, reportPath: null }, s);
    expect(full.match(/claim number/g)?.length).toBe(11);
    expect(full).not.toContain("more (--full)");
  });

  test("long evidence is cut to the width, and every mark has a glyph", async () => {
    const r = await result();
    const long: Problem = {
      mark: "bad",
      kind: "request",
      id: "I7",
      text: "merge to develop and then tag the release and announce it everywhere",
      detail: `not done: ${"x".repeat(300)}`,
    };
    const marks: Problem[] = (["partly", "gap", "warn"] as const).map((mark) => ({ mark, kind: "file", id: null, text: `f-${mark}`, detail: "d" }));
    const s = {
      ...summarize(r),
      problems: [long, ...marks],
      did: { done: 0, partly: 1, notDone: 1, unclear: 1 },
      scope: { againstInstruction: 0, unexplained: 2, checked: true },
      truth: { contradicted: 1, stale: 1, overstated: 1, unsupported: 1, verified: 0, silentGaps: 2 },
    };
    const out = renderTerminal(r, { color: true, unicode: false, full: false, reportPath: null, width: 80 }, s);
    const line = out.split("\n").find((l) => l.includes("I7"))!;
    expect(line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").length).toBeLessThanOrEqual(80);
    expect(line).toContain('I7 "merge to develop and then tag...');
    for (const g of ["[x]", "[/]", "[?]", "[~]"]) expect(out).toContain(g);
    for (const w of ["1 partly", "1 not done", "1 unclear", "2 unexplained files", "1 contradicted", "1 overstated", "1 unsupported", "2 silent gaps"])
      expect(out).toContain(w);
  });

  test("uses the real terminal width: wide terminals show more, cuts land on word boundaries, narrow ones floor at 60", async () => {
    const r = await result();
    const text = "Move the driver, admin and backend apps from the clienttesting domain to ocarindia.com without breaking them";
    const p: Problem = { mark: "bad", kind: "request", id: "I1", text, detail: `not in change: ${"word ".repeat(60)}` };
    const s = { ...summarize(r), problems: [p] };
    const at = (width: number) =>
      renderTerminal(r, { color: false, unicode: false, full: false, reportPath: null, width }, s)
        .split("\n")
        .find((l) => l.includes("I1"))!;
    const wide = at(300);
    expect(wide).toContain(`"${text}"`); // 120 columns of quote room: whole request fits
    const mid = at(120);
    expect(mid).toContain('"Move the driver, admin and backend apps from...');
    expect(mid.length).toBeLessThanOrEqual(120);
    expect(at(30).length).toBeLessThanOrEqual(60); // floor
    expect(at(30)).toBe(at(60));
    expect(wide.length).toBeLessThanOrEqual(300);
  });

  test("the undisclosed-file reason reads once", async () => {
    const r = await result();
    const { undisclosedReason } = await import("../src/summary.ts");
    expect(undisclosedReason("not asked for, not mentioned, not linked to anything asked for")).toBe(
      "not asked for, never mentioned (not linked to anything asked for)",
    );
    expect(undisclosedReason(undefined)).toBe("not asked for, never mentioned");
    expect(undisclosedReason("changed outside this session's edits")).toBe("not asked for, never mentioned (changed outside this session's edits)");
    const s = summarize(r);
    for (const pr of s.problems) expect(pr.detail.match(/not asked for/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  test("terminal escape sequences in transcript text never reach the terminal", async () => {
    const r = await result();
    const esc = String.fromCharCode(27);
    const evil: Problem[] = [
      { mark: "bad", kind: "claim", id: null, text: `all ${esc}[2Jgreen${esc}]0;pwned\x07`, detail: `contradicted: ${esc}[31mred${esc}[0m \x08\x7f done` },
      { mark: "warn", kind: "file", id: null, text: `src/${esc}[1mfile.ts`, detail: "d" },
    ];
    const s = { ...summarize(r), problems: evil };
    for (const full of [false, true]) {
      const out = renderTerminal(r, { color: false, unicode: false, full, reportPath: null }, s);
      expect(out).not.toContain(esc);
      expect(out).not.toContain("\x07");
      expect(out).toContain("[2Jgreen");
    }
  });

  test("a clean review says so", async () => {
    const r = await result();
    const s = { ...summarize(r), problems: [], notes: [], scope: { againstInstruction: 0, unexplained: 0, checked: true } };
    expect(renderTerminal(r, { color: false, unicode: false, full: false, reportPath: null }, s)).toContain("[ok] No problems found.");
    const none = { ...s, did: { done: 0, partly: 0, notDone: 0, unclear: 0 }, scope: { ...s.scope, checked: false }, truth: { ...s.truth, verified: 0 } };
    const out = renderTerminal(r, { color: false, unicode: false, full: false, reportPath: null }, none);
    expect(out).toContain("no requests found");
    expect(out).toContain("no change found to check");
    expect(out).toContain("no checkable claims");
  });
});

describe("summarize", () => {
  test("separates problems from notes", async () => {
    const s = summarize(await result());
    expect(s.problems.map((p) => p.kind)).toEqual(["file"]);
    expect(s.notes.map((n) => n.detail)).toEqual(["sensitive path changed", "1 skip/only added", "net assertions went down by 1"]);
  });
});
