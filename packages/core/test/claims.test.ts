// Families of sentences for the claim, command and constraint rules fixed after the adversarial bench. Each rule gets several
// phrasings that must trigger and near misses that must not, so the rules are not tied to the bench sentences.

import { describe, expect, test } from "bun:test";
import { checkClaims } from "../src/claims.ts";
import { TEST_COMMAND_RE } from "../src/ingest/claude-code.ts";
import type { FileProvenance, Provenance } from "../src/provenance.ts";
import { classifyScope, isFileConstraint } from "../src/scope.ts";
import type { Session } from "../src/types.ts";

const T = (m: number) => new Date(Date.UTC(2026, 0, 1, 10, m)).toISOString();

/** A one-prompt session whose closing reply is `reply`, after the given shell commands. */
function replyAfter(reply: string, cmds: { cmd: string; failed?: boolean }[] = []): Session {
  return {
    prompts: [{ index: 1, uuid: "", timestamp: "", text: "do it" }],
    edits: [],
    turnDeltas: [],
    shell: cmds.map((c, i) => ({
      seq: i + 1,
      afterPrompt: 1,
      toolUseId: "",
      command: c.cmd,
      isTest: TEST_COMMAND_RE.test(c.cmd),
      failed: c.failed ?? false,
      timestamp: T(i + 1),
    })),
    assistant: [{ afterPrompt: 1, uuid: "", timestamp: T(9), text: reply }],
  } as unknown as Session;
}
const kinds = (reply: string, cmds: { cmd: string; failed?: boolean }[] = []) =>
  checkClaims(replyAfter(reply, cmds), [], null).claims.map((c) => `${c.kind}:${c.verdict}`);
const none = (sentences: string[]) => for_each(sentences, (s) => expect(kinds(s)).toEqual([]));
function for_each(xs: string[], f: (s: string) => void) {
  for (const x of xs) f(x);
}

describe("completion claims that were missed", () => {
  test("a PR the agent says it created or that is up is a pr claim, even with a number", () => {
    for (const s of ["PR is up.", "Created PR #42.", "I opened PR #7 for this change.", "The pull request is open.", "Raised PR #19 against main."])
      expect(kinds(s)).toEqual(["pr:unsupported"]);
    expect(kinds("Created PR #42.", [{ cmd: "gh pr create --fill" }])).toEqual(["pr:verified"]);
  });
  test("a PR number that is only history, a plan or a condition is not a pr claim", () => {
    none([
      "PR #134 replaced the shipped icons.",
      "On Oct 3, PR #134 was opened by Dana.",
      "Once the PR is up we can merge.",
      "I'll create PR #9 after the tests.",
    ]);
  });

  test("'the build succeeds' in its present tense forms is a build claim", () => {
    for (const s of ["The build succeeds.", "Build passes.", "The build completed.", "Build is green now.", "The builds pass."])
      expect(kinds(s)).toEqual(["build:unsupported"]);
    expect(kinds("The build succeeds.", [{ cmd: "npm run build" }])).toEqual(["build:verified"]);
  });
  test("a build that passes something along, advice and an instruction to build are not build claims", () => {
    none(["The build passes the flag to the compiler.", "Make sure the build passes.", "Build the release APK next.", "Once the build succeeds we ship."]);
  });

  test("'nothing left to do' completes a claim; 'nothing else was changed' is an only-touched claim", () => {
    for (const s of [
      "That's everything, nothing left to do.",
      "Everything is in place, nothing left to do.",
      "All done, nothing left to do.",
      "Finished all of it, nothing left to do.",
    ])
      expect(kinds(s)[0]).toMatch(/^everything:/);
    for (const s of [
      "Just the config, nothing else was changed.",
      "Nothing else was touched.",
      "Nothing else got modified.",
      "Only the parser changed; nothing else has been edited.",
    ])
      expect(kinds(s)[0]).toMatch(/^only-touched:/);
  });
  test("other 'nothing' sentences stay non-claims", () => {
    none(["Nothing is committed.", "Nothing else was committed.", "Nothing has been deployed.", "Nothing else was pushed yet."]);
  });

  test("'not done' and 'still open' are admissions, not a 'done' claim", () => {
    for (const s of [
      "Not done: the retry limit is still open.",
      "The migration is not done.",
      "Still open: the rate limit work.",
      "The login fix is not working yet.",
    ])
      expect(kinds(s)).toEqual([]);
    expect(kinds("The login fix is working now.")[0]).toMatch(/^fixed:/);
    expect(kinds("The cache fix is done now.")[0]).toMatch(/^fixed:/);
  });

  test("a results-table row and a pasted pass summary are tests claims; a failing or unrelated one is not", () => {
    for (const s of ["| unit tests | passed |", "| **Unit tests** | passing |", "| e2e suite | ✅ green |", "| API tests | pass |"])
      expect(kinds(s)).toEqual(["tests:unsupported"]);
    for (const s of [
      "```\n12 passed in 0.8s\n```",
      "```\nTests: 14 passed, 14 total\n```",
      "```\n===== 9 passed in 1.20s =====\n```",
      "```\ntest result: ok. 9 passed; 0 failed\n```",
    ])
      expect(kinds(s)).toEqual(["tests:unsupported"]);
    expect(kinds("```\n12 passed in 0.8s\n```", [{ cmd: "pytest -q" }])).toEqual(["tests:verified"]);
    none(["| unit tests | 3 failed |", "| Check | Result |", "```\n9 passed, 2 failed\n```", "```\nnpm install\nadded 12 packages\n```"]);
  });
});

describe("history and reported speech are not claims about this turn", () => {
  test("time markers and other people's deploys", () => {
    none([
      "Last week's release was deployed by Dana.",
      "The suite was green on Friday's build, before my change.",
      "The tests passed yesterday on CI.",
      "The branch was merged by Priya 3 days ago.",
      "It was shipped last month.",
    ]);
  });
  test("what a document or a person says, and quoted lines", () => {
    none([
      "The README says all tests pass.",
      "According to the changelog, the build passes.",
      "The ticket claims it was deployed.",
      "> all tests pass\n(that line is from the README)",
    ]);
  });
  test("the agent's own earlier work is still a claim", () => {
    expect(kinds("I ran the tests earlier and they passed.")).toEqual(["tests:unsupported"]);
    expect(kinds("The test output says all 42 tests passed.")).toEqual(["tests:unsupported"]);
    expect(kinds("The release was deployed by me.")).toEqual(["deploy:unsupported"]);
    expect(kinds("Fixed the bug that broke last week.")[0]).toMatch(/^fixed:/);
  });
});

describe("claims that need their own pattern", () => {
  test("a numbered PR status claim is a pr claim, while a PR number in a historical sentence still is not", () => {
    for (const s of ["PR #42 is up.", "The pull request #42 is open.", "Pull request #19 is created.", "PR 42 is open."]) {
      expect([s, kinds(s)]).toEqual([s, ["pr:unsupported"]]);
      expect([s, kinds(s, [{ cmd: "gh pr create --fill" }])]).toEqual([s, ["pr:verified"]]);
    }
    for (const s of ["PR #134 replaced the shipped icons.", "On Oct 3, PR #134 is open again.", "See PR #42 for the background."]) {
      expect([s, kinds(s)]).toEqual([s, []]);
    }
  });

  test("'nothing left to do' on its own is a completion claim, and other uses of 'nothing' are still not claims", () => {
    for (const s of ["Nothing left to do.", "Nothing else left to do.", "There is nothing left to do.", "Nothing remaining."]) {
      expect([s, kinds(s).map((k) => k.split(":")[0])]).toEqual([s, ["everything"]]);
    }
    for (const s of ["Nothing is committed.", "Nothing was changed in the lockfile and I did not run the build."]) {
      expect([s, kinds(s)]).toEqual([s, []]);
    }
  });
});

describe("make is a test runner", () => {
  test("make test, make tests and make check count; make in a path or another target does not", () => {
    for (const c of ["make test", "make tests", "make -j4 check", "cd api && make test", "FOO=1 make test"]) expect(TEST_COMMAND_RE.test(c)).toBe(true);
    for (const c of [
      "cat docs/make test.md",
      "cmake test",
      "./make test",
      "make testdata",
      "make build",
      "git commit -m 'make test faster'".replace("make test faster", "x"),
    ])
      expect(TEST_COMMAND_RE.test(c)).toBe(false);
    expect(kinds("All tests pass.", [{ cmd: "make test" }])).toEqual(["tests:verified"]);
  });

  test("a make dry run, query or help run executes no recipe, so it is not test evidence", () => {
    for (const c of [
      "make -n test",
      "make --dry-run test",
      "make --just-print tests",
      "make --recon check",
      "make -q check",
      "make --question test",
      "make -nj4 test",
      "make -j4 -n test",
      "make test -n",
      "make test --dry-run",
      "cd api && make -n test",
    ])
      expect([c, TEST_COMMAND_RE.test(c)]).toEqual([c, false]);
    for (const c of [
      "make test",
      "make -j4 test",
      "make --no-print-directory test",
      "make test -j4",
      "make test FOO=bar",
      "make test && ls -n",
      "make -k check",
    ])
      expect([c, TEST_COMMAND_RE.test(c)]).toEqual([c, true]);
    // the evidence rule end to end: a dry run cannot verify "all tests pass"
    expect(kinds("All tests pass.", [{ cmd: "make -n test" }])).toEqual(["tests:unsupported"]);
  });
});

describe("what a constraint protects", () => {
  const fp = (path: string, o: Partial<FileProvenance> = {}): FileProvenance => ({
    path,
    status: "modified",
    addedLines: 5,
    attributedLines: 5,
    otherSessionLines: 0,
    viaBackups: 0,
    turns: [1],
    touchedByAgent: true,
    shellMentioned: false,
    inPrompts: false,
    inAgentText: false,
    ...o,
  });
  const prov = (files: FileProvenance[]): Provenance =>
    ({
      files,
      totalAddedLines: 0,
      attributedLines: 0,
      otherSessionLines: 0,
      viaBackups: 0,
      otherSessions: [],
      coverage: 1,
      editsOutsideRepo: 0,
      agentFilesNotInDiff: [],
    }) as Provenance;
  const against = (prompts: string[], touched: [string, number[]][], named: string[] = []) => {
    const files = touched.map(([p, turns]) => fp(p, { turns, inPrompts: named.includes(p) }));
    const scope = classifyScope({ provenance: prov(files), prompts: prompts.map((text, i) => ({ index: i + 1, text })) });
    return files.filter((f) => scope.get(f.path)!.againstInstruction).map((f) => f.path);
  };
  const AUTH = "src/auth/token.ts";
  const CART = "src/cart.ts";

  test("leave alone, off limits, read-only, frozen and hands off protect the named file", () => {
    for (const text of [
      `Add a flag to ${CART}. Please leave ${AUTH} alone.`,
      `Add a flag to ${CART}. ${AUTH} is off limits.`,
      `Add a flag to ${CART}. ${AUTH} must stay read-only.`,
      `Add a flag to ${CART}. Hands off ${AUTH}.`,
      `Add a flag to ${CART}. ${AUTH} is frozen.`,
      `Add a flag to ${CART}. Do not modify ${AUTH}.`,
    ])
      expect(
        against(
          [text],
          [
            [AUTH, [1]],
            [CART, [1]],
          ],
          [AUTH, CART],
        ),
      ).toEqual([AUTH]);
  });
  test("goals and descriptions that only look similar are not constraints", () => {
    for (const text of [
      "Make the endpoint read-only.",
      "Keep the tests working.",
      "The config is loaded once.",
      "Leave a comment on the PR.",
      "It froze on the login screen.",
    ])
      expect(isFileConstraint(text)).toBe(false);
  });

  test("'without changing X' protects X, never the file the request is about", () => {
    for (const text of [
      `Add a flag to ${CART} without changing ${AUTH}.`,
      `Update ${CART} without touching ${AUTH}.`,
      `Refactor ${CART} but without modifying ${AUTH}.`,
      `Add a flag to ${CART}, without editing ${AUTH}.`,
    ]) {
      expect(
        against(
          [text],
          [
            [AUTH, [1]],
            [CART, [1]],
          ],
          [AUTH, CART],
        ),
      ).toEqual([AUTH]);
      expect(against([text], [[CART, [1]]], [AUTH, CART])).toEqual([]);
    }
  });

  test("a trailing 'X is off limits' clause protects only its own subject, not the file requested earlier in the sentence", () => {
    for (const text of [
      `Add a flag to ${CART}, but ${AUTH} is off limits.`,
      `Add a flag to ${CART}; ${AUTH} is off limits.`,
      `Add a flag to ${CART} and ${AUTH} is off limits.`,
      `Add a flag to ${CART}, then ${AUTH} stays read-only.`,
      `Add a flag to ${CART} while ${AUTH} remains frozen.`,
    ]) {
      expect([
        text,
        against(
          [text],
          [
            [AUTH, [1]],
            [CART, [1]],
          ],
          [AUTH, CART],
        ),
      ]).toEqual([text, [AUTH]]);
      expect([text, against([text], [[CART, [1]]], [AUTH, CART])]).toEqual([text, []]);
    }
    // a coordinated subject protects every file it names
    const both = `${AUTH} and src/billing/ledger.ts are off limits.`;
    expect(
      against(
        [both],
        [
          [AUTH, [1]],
          ["src/billing/ledger.ts", [1]],
          [CART, [1]],
        ],
        [AUTH, CART],
      ),
    ).toEqual([AUTH, "src/billing/ledger.ts"]);
  });

  test("a later prompt that lifts the constraint ends it from that turn on", () => {
    const first = `Don't touch ${AUTH} for now.`;
    const ask = `Add a flag to ${CART}.`;
    for (const lift of [
      `Actually you can edit ${AUTH} now.`,
      `Go ahead and change ${AUTH}.`,
      `Feel free to modify ${AUTH}.`,
      `It's fine to touch ${AUTH} now.`,
    ]) {
      expect(against([first, ask, lift], [[AUTH, [3]]], [AUTH])).toEqual([]); // edited after the lift
      expect(against([first, ask, lift], [[AUTH, [2]]], [AUTH])).toEqual([AUTH]); // edited before it
    }
    // an unrelated permission or a lift of another file does not end it
    expect(against([first, ask, `You can edit ${CART} now.`], [[AUTH, [3]]], [AUTH])).toEqual([AUTH]);
    expect(against([first, ask, "Looks good, thanks."], [[AUTH, [3]]], [AUTH])).toEqual([AUTH]);
  });
});
