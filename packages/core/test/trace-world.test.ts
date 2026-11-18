import { expect, test } from "bun:test";
import { openRepo, reviewSession } from "../src/review.ts";
import { World } from "./trace-world.ts";

test("SessionBuilder.run and say are parsed by the ingest: review sees the command and the reply", async () => {
  const w = new World();
  w.write("src/a.ts", ["export const base = 1;"]);
  const past = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  Object.assign(process.env, { GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past });
  w.commit("init");
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
  w.write("src/a.ts", ["export const base = 1;", "export const added = 2;"]);
  w.session("s1")
    .prompt("Add added to src/a.ts")
    .edit("src/a.ts", ["export const added = 2;"])
    .run("bun test", { failed: true, output: "1 fail" })
    .say("All tests pass.")
    .done();
  const ctx = openRepo(w.repo, w.projects)!;
  const session = ctx.getSession(ctx.refs[0]!.path)!;
  expect(session.shell.map((s) => [s.command, s.isTest, s.failed])).toEqual([["bun test", true, true]]);
  expect(session.assistant.map((a) => [a.afterPrompt, a.text])).toEqual([[1, "All tests pass."]]);
  const r = await reviewSession({ ctx, session, ledger: "heuristic" });
  expect(r.claims?.claims.map((c) => [c.kind, c.verdict])).toEqual([["tests", "contradicted"]]);
});
