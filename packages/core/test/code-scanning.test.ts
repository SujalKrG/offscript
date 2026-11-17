import { describe, expect, test } from "bun:test";
import { hookCommand } from "../../cli/src/hook.ts";
import { spawnTarget } from "../src/judge/claude-cli.ts";
import type { ShellRun } from "../src/types.ts";
import { actionEvidence } from "../src/verdicts.ts";

const run = (command: string): ShellRun => ({ seq: 1, afterPrompt: 1, toolUseId: "t", command, isTest: false, failed: false });

describe("code scanning fixes", () => {
  test("git option patterns run in linear time on hostile input (ReDoS)", () => {
    const hostile = `git ${"-! ".repeat(40)}x`;
    const started = performance.now();
    for (const kind of ["commit", "push", "merge", "deploy"] as const) actionEvidence(kind, [run(hostile)]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("real git invocations with options are still recognised", () => {
    expect(actionEvidence("commit", [run('git -c user.name=x commit -m "m"')]).status).toBe("ok");
    expect(actionEvidence("push", [run("git -C ../repo push origin main")]).status).toBe("ok");
    expect(actionEvidence("merge", [run("git --no-pager merge feature")]).status).toBe("ok");
    expect(actionEvidence("commit", [run("git log --oneline")]).status).toBe("missing");
  });

  test("cmd.exe quoting doubles backslashes only before a quote or the closing quote", () => {
    expect(spawnTarget({ cmd: "C:\\Jo Smith\\claude.cmd", shell: true })).toBe('"C:\\Jo Smith\\claude.cmd"');
    expect(spawnTarget({ cmd: 'a\\"b', shell: true })).toBe('"a\\\\\\"b"');
    expect(spawnTarget({ cmd: "C:\\dir\\", shell: true })).toBe('"C:\\dir\\\\"');
  });

  test("the hook command turns backslashes into slashes and escapes quote characters in one pass", () => {
    expect(hookCommand("C:\\Users\\me\\main.ts")).toBe('bun "C:/Users/me/main.ts" review --hook');
    expect(hookCommand('/a"b$c`d/main.ts')).toBe('bun "/a\\"b\\$c\\`d/main.ts" review --hook');
  });
});
