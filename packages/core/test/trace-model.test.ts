// Seeded model-based test for the Agent Trace export, in the style of Git AI's attribution fuzzer.
// A generator builds sessions and a real git repo from random operations. Every line it creates gets a
// unique text. The generator keeps its own model of who wrote each line and computes the expected
// attribution itself, WITHOUT calling the exporter. Then the export must match that model exactly.
// On failure the seed and the full operation log are printed, so the case can be replayed.
import { describe, expect, test } from "bun:test";
import { validateTraceRecord } from "../src/trace-validate.ts";
import { World } from "./trace-world.ts";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Author {
  session: "sess-a" | "sess-b";
  model: string;
}
interface Line {
  id: number;
  text: string;
  author: Author | null; // null: typed by a human, no transcript explains it
}
type Tree = Map<string, Line[]>;

interface CommitModel {
  sha: string;
  parent: Tree;
  after: Tree;
  renames: Map<string, string>; // new path -> old path, as git will report it
}

const MODELS_A = ["claude-opus-4-1", "claude-sonnet-4-5"];
const MODEL_B = "claude-haiku-4-5";

function snapshot(t: Tree): Tree {
  return new Map([...t].map(([p, ls]) => [p, [...ls]]));
}
const sameTree = (a: Tree, b: Tree) =>
  a.size === b.size && [...a].every(([p, ls]) => b.get(p)?.length === ls.length && ls.every((l, i) => b.get(p)![i]!.id === l.id));

interface Expected {
  // sha -> path -> "session|model" -> line numbers
  commits: Map<string, Map<string, Map<string, Set<number>>>>;
  unresolvedByCommit: Map<string, number>;
  skipped: number;
  trees: Map<string, Tree>;
}

function runScenario(seed: number, log: string[]): { w: World; expected: Expected } {
  const rng = mulberry32(seed);
  const int = (n: number) => Math.floor(rng() * n);
  const pick = <T>(xs: T[]): T => xs[int(xs.length)]!;
  const w = new World();
  const A = w.session("sess-a").prompt("work on the repo");
  const B = w.session("sess-b").prompt("work on the same repo");
  const tree: Tree = new Map();
  let head: Tree = new Map();
  const commits: CommitModel[] = [];
  const editedA = new Set<string>();
  const locked = new Set<string>(); // renamed since the last commit: only the forced insert may touch it
  let pendingRenames = new Map<string, string>();
  let counter = 0;

  const newLine = (author: Author | null): Line => {
    const id = ++counter;
    return { id, text: `export const v${seed}x${id} = compute(${id});`, author };
  };
  const sync = (path: string) =>
    w.write(
      path,
      tree.get(path)!.map((l) => l.text),
    );
  const who = (): Author => (rng() < 0.75 ? { session: "sess-a", model: pick(MODELS_A) } : { session: "sess-b", model: MODEL_B });
  const builder = (a: Author) => (a.session === "sess-a" ? A : B);
  const files = (filter: (p: string, ls: Line[]) => boolean = () => true) => [...tree].filter(([p, ls]) => filter(p, ls)).map(([p]) => p);

  const insert = (path: string, author: Author | null, k: number, label: string) => {
    const ls = tree.get(path)!;
    const at = int(ls.length + 1);
    const added = Array.from({ length: k }, () => newLine(author));
    ls.splice(at, 0, ...added);
    sync(path);
    if (author) {
      builder(author).edit(
        path,
        added.map((l) => l.text),
        [],
        author.model,
      );
      if (author.session === "sess-a") editedA.add(path);
    }
    log.push(`${label} ${path} at ${at}: ${added.map((l) => `${l.id}(${author ? `${author.session}/${author.model}` : "human"})`).join(" ")}`);
  };

  const doCommit = (amend: boolean) => {
    const last = commits[commits.length - 1];
    const base = amend && last ? last.parent : head;
    if (sameTree(tree, amend && last ? last.after : head)) return false;
    const sha = w.commit(amend ? "amended" : `commit ${commits.length + 1}`, amend);
    const renames = new Map([...pendingRenames].filter(([, p]) => base.has(p)));
    if (amend && last) {
      for (const [q, p] of renames) last.renames.set(q, p);
      last.sha = sha;
      last.after = snapshot(tree);
    } else commits.push({ sha, parent: snapshot(head), after: snapshot(tree), renames });
    head = snapshot(tree);
    pendingRenames = new Map();
    locked.clear();
    log.push(`${amend ? "amend" : "commit"} -> ${sha.slice(0, 8)}`);
    return true;
  };

  const steps = 10 + int(8);
  for (let i = 0; i < steps; i++) {
    const op = rng();
    if (op < 0.22 || tree.size === 0) {
      const a = who();
      const path = `src/f${++counter}.ts`;
      const lines = Array.from({ length: rng() < 0.4 ? 10 + int(3) : 2 + int(4) }, () => newLine(a));
      tree.set(path, lines);
      sync(path);
      builder(a).create(
        path,
        lines.map((l) => l.text),
        a.model,
      );
      if (a.session === "sess-a") editedA.add(path);
      log.push(`create ${path}: ${lines.map((l) => l.id).join(" ")} by ${a.session}/${a.model}`);
    } else if (op < 0.5) {
      const open = files((p) => !locked.has(p));
      if (open.length) insert(pick(open), who(), 1 + int(3), "insert");
    } else if (op < 0.62) {
      const open = files((p, ls) => !locked.has(p) && ls.length > 0);
      if (open.length) {
        const path = pick(open);
        const ls = tree.get(path)!;
        const at = int(ls.length);
        const a = who();
        const old = ls[at]!;
        const fresh = newLine(a);
        ls[at] = fresh;
        sync(path);
        builder(a).edit(path, [fresh.text], [old.text], a.model);
        if (a.session === "sess-a") editedA.add(path);
        log.push(`replace ${path} line ${at + 1}: ${old.id} -> ${fresh.id} by ${a.session}/${a.model}`);
      }
    } else if (op < 0.72) {
      const open = files((p) => !locked.has(p));
      if (open.length) insert(pick(open), null, 1, "human insert");
    } else if (op < 0.88) doCommit(false);
    else if (op < 0.94) {
      const last = commits[commits.length - 1];
      const open = files((p) => !locked.has(p) && !!last?.after.has(p));
      if (last && open.length) {
        insert(pick(open), { session: "sess-a", model: pick(MODELS_A) }, 1, "insert before amend");
        doCommit(true);
      }
    } else {
      // Rename a committed file with at most two changed lines, then let the agent add one line under the new name.
      const cands = files((p, ls) => {
        const h = head.get(p);
        return (
          !locked.has(p) &&
          !!h &&
          ls.length >= 10 &&
          ls.filter((l) => !h.some((x) => x.id === l.id)).length + h.filter((x) => !ls.some((l) => l.id === x.id)).length <= 2
        );
      });
      if (cands.length) {
        const from = pick(cands);
        const to = `src/r${++counter}.ts`;
        w.move(from, to);
        tree.set(to, tree.get(from)!);
        tree.delete(from);
        pendingRenames.set(to, from);
        log.push(`rename ${from} -> ${to}`);
        insert(to, { session: "sess-a", model: pick(MODELS_A) }, 1, "insert after rename");
        locked.add(to);
      }
    }
  }
  doCommit(false);
  if (commits.length === 0) throw new Error("scenario made no commit");

  // Uncommitted tail: agent lines in a committed file the session edited. They have no commit, so they are skipped and counted.
  let skipped = 0;
  if (rng() < 0.5) {
    const open = files((p) => editedA.has(p) && head.has(p));
    if (open.length) {
      const path = pick(open);
      const a: Author = { session: "sess-a", model: pick(MODELS_A) };
      const before = tree.get(path)!.length;
      insert(path, a, 1 + int(2), "uncommitted insert");
      skipped = tree.get(path)!.length - before;
    }
  }
  A.done();
  B.done();

  // Expected attribution, from the model only.
  const expected: Expected = { commits: new Map(), unresolvedByCommit: new Map(), skipped, trees: new Map() };
  for (const c of commits) {
    const byPath = new Map<string, Map<string, Set<number>>>();
    let unresolved = 0;
    for (const [path, after] of c.after) {
      const oldPath = c.renames.get(path);
      const included = editedA.has(path) || (oldPath !== undefined && editedA.has(oldPath));
      if (!included) continue;
      const before = new Set((c.parent.get(path) ?? (oldPath ? c.parent.get(oldPath) : undefined) ?? []).map((l) => l.id));
      for (const [i, l] of after.entries()) {
        if (before.has(l.id)) continue;
        if (!l.author) {
          unresolved++;
          continue;
        }
        const key = `${l.author.session}|anthropic/${l.author.model}`;
        const m = byPath.get(path) ?? new Map<string, Set<number>>();
        const s = m.get(key) ?? new Set<number>();
        s.add(i + 1);
        m.set(key, s);
        byPath.set(path, m);
      }
    }
    expected.commits.set(c.sha, byPath);
    expected.unresolvedByCommit.set(c.sha, unresolved);
    expected.trees.set(c.sha, c.after);
  }
  return { w, expected };
}

function checkScenario(seed: number) {
  const log: string[] = [];
  try {
    const { w, expected } = runScenario(seed, log);
    const { records, summary } = w.export("sess-a");
    const withLines = [...expected.commits].filter(([, files]) => files.size > 0).map(([sha]) => sha);
    expect(records.map((r) => r.vcs.revision).sort()).toEqual(withLines.sort());
    let credited = 0;
    for (const r of records) {
      expect(validateTraceRecord(r)).toEqual([]);
      const want = expected.commits.get(r.vcs.revision)!;
      const meta = r.metadata["io.github.sujalkrg.offscript"] as { conversation_sessions: Record<string, string[]> };
      expect(r.files.map((f) => f.path).sort()).toEqual([...want.keys()].sort());
      for (const f of r.files) {
        const got = new Map<string, Set<number>>();
        for (const [i, c] of f.conversations.entries()) {
          const key = `${meta.conversation_sessions[f.path]![i]}|${c.contributor.model_id}`;
          const s = got.get(key) ?? new Set<number>();
          for (const rg of c.ranges) for (let n = rg.start_line; n <= rg.end_line; n++) s.add(n);
          got.set(key, s);
          credited += c.ranges.reduce((t, rg) => t + rg.end_line - rg.start_line + 1, 0);
        }
        const exp = want.get(f.path)!;
        expect([...got.keys()].sort()).toEqual([...exp.keys()].sort());
        for (const [k, lines] of exp) expect([...got.get(k)!].sort((a, b) => a - b)).toEqual([...lines].sort((a, b) => a - b));
      }
      // Round trip: the commit really holds those lines at those numbers.
      const tree = expected.trees.get(r.vcs.revision)!;
      for (const f of r.files) {
        const real = w.show(r.vcs.revision, f.path);
        expect(real).toEqual(tree.get(f.path)!.map((l) => l.text));
        for (const c of f.conversations) for (const rg of c.ranges) expect(real.length).toBeGreaterThanOrEqual(rg.end_line);
      }
      expect((r.metadata["io.github.sujalkrg.offscript"] as { unresolved_lines: number }).unresolved_lines).toBe(
        expected.unresolvedByCommit.get(r.vcs.revision)!,
      );
    }
    expect(summary.unresolvedLines).toBe([...expected.unresolvedByCommit.values()].reduce((a, b) => a + b, 0));
    expect(summary.skippedUncommittedLines).toBe(expected.skipped);
    expect(summary.commits).toBe(records.length);
    expect(summary.creditedLines).toBe(credited);
  } catch (e) {
    throw new Error(`export does not match the model. Replay with seed ${seed}.\nOperations:\n  ${log.join("\n  ")}\n\n${(e as Error).message}`);
  }
}

describe("seeded model-based export", () => {
  for (const seed of [1, 4, 7, 8, 12, 17, 18, 21]) {
    test(`seed ${seed}: the export equals the attribution the generator computed on its own`, () => checkScenario(seed), 60_000);
  }
});
