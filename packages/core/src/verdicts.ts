// Verdicts: for each thing you asked for, did the agent do it? Evidence first, no model.
//
// Each intent gets a window of turns: its source prompts, plus the follow-up prompts after them
// ("yes", "continue", "merge") until the next prompt that starts a different intent. Inside that
// window we look for three kinds of independent evidence, never the agent's own summary:
//   code     lines written in those turns that are still in the reviewed change
//   actions  commands that ran in those turns (commit, push, PR, merge, tests, type check, build, deploy)
//            and whether they succeeded
//   answer   a substantive reply, for requests that only ask for information
// When the evidence does not settle it, the verdict says so ("needs judgment") instead of guessing.

import type { Provenance } from "./provenance.ts";
import { type FileScope, isFileConstraint } from "./scope.ts";
import type { Intent, Session, ShellRun } from "./types.ts";

export type Verdict =
  | "done" // the evidence the request calls for is there
  | "partly done" // some of it is there, some is missing
  | "failed" // it was attempted and the attempt failed (a command exited non-zero)
  | "not done" // no evidence at all
  | "not in change" // code was written, but none of it is in the reviewed change
  | "answered" // an information request with a substantive reply
  | "kept" // a "don't touch" constraint, and nothing it covers was changed
  | "not checked" // a constraint offscript cannot check from files (e.g. "use bun, not npm")
  | "violated" // a constraint the agent broke
  | "superseded" // you replaced this request with another
  | "cancelled" // you dropped this request
  | "needs judgment"; // evidence exists but cannot settle it

export type ActionKind = "commit" | "push" | "pr" | "merge" | "tests" | "typecheck" | "build" | "deploy";

export interface ActionEvidence {
  kind: ActionKind;
  status: "ok" | "failed" | "unknown" | "missing"; // unknown: it ran, but no result was recorded
  command: string | null;
}

export interface IntentVerdict {
  id: string;
  text: string;
  verdict: Verdict;
  why: string; // one line, plain words
  turns: number[]; // prompt indices in this intent's window
  files: string[]; // files with lines from these turns that are in the reviewed change
  actions: ActionEvidence[];
}

export interface VerdictReport {
  verdicts: IntentVerdict[];
  extraFiles: string[]; // changed by the agent, linked to no request (scope drift)
  counts: Partial<Record<Verdict, number>>;
}

/**
 * What a request asks to be done. An action counts only when it is asked for as an action: the request starts
 * with it ("Commit and push...") or chains it ("..., then open a PR"). Nouns do not count: "push notifications",
 * "commit message", "merge conflict" are not requests to push, commit or merge.
 */
const ACTION_ASKED: [ActionKind, RegExp][] = [
  ["commit", /\bcommit\b(?!\s+(message|messages|hash|history|log|lint))/i],
  ["push", /\bpush\b(?!\s+(notification|notifications|token|tokens|service|alert|alerts|message|messages))/i],
  ["pr", /\b(pr|prs|pull requests?)\b/i],
  ["merge", /\bmerg(e|ed|ing)\b(?!\s+(conflict|conflicts|request|requests|sort|base))/i],
  ["tests", /\b(run|re-?run|execute)\b[^.]{0,40}\b(tests?|suite|e2e|smoke|checklist|cases?)\b|^test\b/i],
  ["typecheck", /\b(tsc|type ?check)/i],
  ["build", /\b(build|apk|aab|ipa)\b[^.]{0,30}\b(release|apk|aab|ipa|android|ios|prod)\b|\brelease build\b/i],
  ["deploy", /\b(deploy|redeploy|ship it|push (it )?to prod(uction)?|roll ?out)\b/i],
];
/** Words a clause starts with when it asks for an action. */
const ACTION_LEAD = new Set("commit push merge deploy redeploy open create raise send run rerun re-run execute build ship release test pr roll".split(" "));

/** The actions a request asks for: only clauses that start with an action verb ("Commit and push...", "..., then open a PR"). */
function actionsAsked(text: string): ActionKind[] {
  const out = new Set<ActionKind>();
  // "and" starts a new clause only when an action verb follows it: "commit and push" splits, "payments and SOS tests" does not.
  const leads = [...ACTION_LEAD].join("|");
  const splitter = new RegExp(`,|;|\\.|\\bthen\\b|\\b(?:and|also|plus)\\b(?=\\s+(?:please\\s+)?(?:${leads})\\b)`, "i");
  for (const clause of withoutNegations(text).split(splitter)) {
    const c = clause.trim().replace(/^(please|now|finally|next)\s+/i, "");
    const lead = c.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!ACTION_LEAD.has(lead)) continue;
    for (const [k, re] of ACTION_ASKED) if (re.test(c)) out.add(k);
  }
  return [...out];
}

/** Test runs: a real runner or a test-named script, not any command that mentions "e2e". */
const TEST_RUN_RE =
  /\b(k6\s+run|maestro\s+(test|cloud)|appium\b|playwright\s+test|detox\s+test|cypress\s+run|newman\s+run|artillery\s+run|locust\s|jest\b|vitest\b|pytest\b|go\s+test\b|phpunit\b|adb\s+shell\s+(am\s+instrument|input|monkey)|gradlew\s+\S*test)|\b(bun|npm|pnpm|yarn|npx)\s+(run\s+)?(test|e2e|smoke)\b|\b(node|bun|tsx|ts-node|deno\s+run|python3?|py)\s+\S*(test|e2e|smoke|load|lifecycle|probe|flow|scenario|qa|verify)\S*\.(c|m)?(js|ts|py)\b/i;

/** Requests that are about getting information, read from their first word ("Analyze...", "Recommend..."). */
const ANSWER_LEAD = new Set(
  "analyze analyse research assess recommend report list investigate measure check verify explain draft determine find estimate review compare summarize summarise show tell inventory confirm figure evaluate audit identify plan outline describe answer advise decide explore".split(
    " ",
  ),
);
/** Requests that need code to change, read from their first word. */
const CODE_LEAD = new Set(
  "fix add implement create remove delete update change refactor redesign integrate make move hide support replace rename extend wire migrate bypass stop prevent handle display clean cleanup write convert improve polish restyle tune optimize enable disable allow block let set".split(
    " ",
  ),
);

/** Remove a prohibition ("do not run load tests", "without deploying") up to the next clause, so it is never read as a request. */
function withoutNegations(text: string): string {
  return text.replace(/\b(do not|don't|dont|never|without|avoid|no need to)\b.*?(?=,|;|\.|\band\b|\bthen\b|\bbut\b|$)/gi, " ");
}

/** What a command did. Matched on the command itself, not on file names that happen to contain the word. */
const ACTION_RAN: Record<ActionKind, RegExp> = {
  commit: /\bgit\s+(-[^\s]+\s+(\S+\s+)?)*commit\b/i,
  push: /\bgit\s+(-[^\s]+\s+(\S+\s+)?)*push\b/i,
  pr: /\bgh\s+pr\s+create\b|\bgh\s+api\b[^|;&]*\/pulls\b(?![^|;&]*\/merge)/i,
  merge: /\bgh\s+pr\s+merge\b|\bgit\s+(-[^\s]+\s+(\S+\s+)?)*merge\s+(?!-base\b)/i,
  tests: /$^/, // decided by ShellRun.isTest or TEST_RUN_RE
  typecheck: /\btsc\b(?!\S)|\b(bun|npm|pnpm|yarn)\s+(run\s+)?type-?check\b/i,
  build:
    /\bgradlew\b[^|;&]*assemble|\bassemble(Release|Debug)\b|\beas\s+build\b|\bexpo\s+(build|export|run:android)\b|\b(bun|npm|pnpm|yarn)\s+(run\s+)?build\b/i,
  deploy:
    /\bvercel\s+(deploy|--prod|-p\b)|\bvercel\b\s*$|\b(bun|npm|pnpm|yarn)\s+(run\s+)?deploy\b|\bterraform\s+apply\b|\baws\s+(ecs\s+update-service|deploy\s|ssm\s+send-command|autoscaling\s+start-instance-refresh)|\bkubectl\s+(apply|rollout)\b|\bfly\s+deploy\b|\brailway\s+up\b|\bgh\s+workflow\s+run\b|\bgit\s+(-[^\s]+\s+(\S+\s+)?)*push\b[^|;&]*\b(main|master|prod|production|release)\b|\bgh\s+pr\s+merge\b[^|;&]*\b(main|master)\b/i, // CI/CD repos deploy on push or merge to main
};

/** Requests that need code to change, by their verb. */
const CODE_VERB =
  /\b(fix|add|implement|build|create|remove|delete|update|change|refactor|redesign|integrate|make|move|hide|support|replace|rename|extend|wire|hook up|migrate|bypass|stop|prevent|handle|show|display|clean ?up)\b/i;
/** Requests that only ask for information. */
const ANSWER_VERB =
  /\b(report|explain|tell|draft|message|analy[sz]e|research|investigate|find out|figure out|check|verify|confirm|estimate|list|plan|review|why|what|how|compare|recommend|inventory|determine|show where|summari[sz]e)\b/i;

export function intentWindows(intents: Intent[], promptCount: number): Map<string, number[]> {
  const starts = new Set<number>();
  for (const i of intents) for (const p of i.sourcePrompts) if (p > 0) starts.add(p);
  const out = new Map<string, number[]>();
  for (const i of intents) {
    const turns = new Set<number>();
    for (const s of i.sourcePrompts) {
      if (s <= 0) continue;
      turns.add(s);
      for (let p = s + 1; p <= promptCount && !starts.has(p); p++) turns.add(p);
    }
    out.set(
      i.id,
      [...turns].sort((a, b) => a - b),
    );
  }
  return out;
}

export function actionEvidence(kind: ActionKind, shell: ShellRun[]): ActionEvidence {
  const runs = shell.filter((r) => (kind === "tests" ? r.isTest || TEST_RUN_RE.test(r.command) : ACTION_RAN[kind].test(r.command)));
  if (runs.length === 0) return { kind, status: "missing", command: null };
  // The last attempt decides (a retry that succeeded fixes an earlier failure); a run with no recorded result proves nothing.
  const last = runs[runs.length - 1]!;
  const earlierFailures = runs.slice(0, -1).filter((r) => r.failed === true).length;
  const status = last.failed === false ? "ok" : last.failed === true ? "failed" : "unknown";
  const note = earlierFailures && status === "ok" ? ` (after ${earlierFailures} failed attempt(s))` : "";
  return { kind, status, command: `${last.byUser ? "(you ran) " : ""}${last.command.slice(0, 120)}${note}` };
}

export function judgeIntents(session: Session, intents: Intent[], provenance: Provenance | null, scope: Map<string, FileScope> | null): VerdictReport {
  const windows = intentWindows(intents, session.prompts.length);
  const verdicts: IntentVerdict[] = [];

  for (const intent of intents) {
    const turns = windows.get(intent.id) ?? [];
    const inWindow = new Set(turns);
    const base = { id: intent.id, text: intent.text, turns, files: [] as string[], actions: [] as ActionEvidence[] };

    if (intent.status === "superseded") {
      verdicts.push({ ...base, verdict: "superseded", why: `replaced by ${intent.supersededBy ?? "a later request"}` });
      continue;
    }
    if (intent.status === "cancelled") {
      verdicts.push({ ...base, verdict: "cancelled", why: "you dropped it" });
      continue;
    }

    if (intent.kind !== "task") {
      // Constraints and preferences: broken only when the agent changed something you said not to touch.
      // A file counts against this constraint only when the constraint's own words match the instruction it broke,
      // so two constraints from one prompt are judged separately.
      const broken = [...(scope ?? new Map<string, FileScope>())].filter(([, s]) => matchesConstraint(intent.text, s)).map(([p]) => p);
      if (broken.length) verdicts.push({ ...base, files: broken, verdict: "violated", why: `changed ${broken.length} file(s) you said not to touch` });
      else if (isFileConstraint(intent.text)) verdicts.push({ ...base, verdict: "kept", why: "nothing it covers was changed" });
      else verdicts.push({ ...base, verdict: "not checked", why: "not something offscript can check from the files that changed" });
      continue;
    }

    const shell = session.shell.filter((r) => inWindow.has(r.afterPrompt));
    const edits = [...session.edits, ...(session.turnDeltas ?? [])].filter((e) => !e.failed && inWindow.has(e.afterPrompt));
    const files = (provenance?.files ?? []).filter((f) => f.attributedLines > 0 && f.turns.some((t) => inWindow.has(t))).map((f) => f.path);
    const lead =
      intent.text
        .trim()
        .split(/\s+/)[0]
        ?.toLowerCase()
        .replace(/[^a-z]/g, "") ?? "";
    const answerLead = ANSWER_LEAD.has(lead);
    // Only the request's own wording counts (the quote can carry neighbouring sentences), minus prohibitions.
    const asked = answerLead ? [] : actionsAsked(intent.text);
    const actions = asked.map((k) => actionEvidence(k, shell));
    // A reply counts as an answer when it closes the request's turns, not when it is progress narration along the way.
    const replies = session.assistant.filter((a) => inWindow.has(a.afterPrompt));
    const closing = replies[replies.length - 1];
    const answered = !!closing && closing.text.length >= 200;
    const wantsCode = !answerLead && (CODE_LEAD.has(lead) || (!asked.length && CODE_VERB.test(withoutNegations(intent.text))));
    const wantsAnswer = answerLead || ANSWER_VERB.test(intent.text);
    const v = { ...base, files, actions };

    const ok = actions.filter((a) => a.status === "ok").map((a) => a.kind);
    const unknown = actions.filter((a) => a.status === "unknown").map((a) => a.kind);
    const failed = actions.filter((a) => a.status === "failed").map((a) => a.kind);
    const missing = actions.filter((a) => a.status === "missing").map((a) => a.kind);
    const codeNote = files.length ? `; ${files.length} file(s) from these turns are in the change` : "";

    if (actions.length) {
      if (failed.length && !ok.length) verdicts.push({ ...v, verdict: "failed", why: `${failed.join(", ")} ran and failed${codeNote}` });
      else if (!missing.length && !failed.length && !unknown.length && wantsCode && !files.length)
        // "Fix X and commit it": the commit ran, but none of the code from these turns is in the change.
        verdicts.push({ ...v, verdict: "partly done", why: `${ok.join(", ")} ran and succeeded, but no code from these turns is in the reviewed change` });
      else if (!missing.length && !failed.length && !unknown.length)
        verdicts.push({ ...v, verdict: "done", why: `${ok.join(", ")} ran and succeeded${codeNote}` });
      else if (!missing.length && !failed.length)
        verdicts.push({
          ...v,
          verdict: "needs judgment",
          why: `${unknown.join(", ")} ran but no result was recorded${ok.length ? `; ok: ${ok.join(", ")}` : ""}${codeNote}`,
        });
      else if (ok.length || files.length || unknown.length)
        verdicts.push({
          ...v,
          verdict: "partly done",
          why: `${[ok.length ? `done: ${ok.join(", ")}` : "", failed.length ? `failed: ${failed.join(", ")}` : "", unknown.length ? `no result recorded: ${unknown.join(", ")}` : "", missing.length ? `no sign of: ${missing.join(", ")}` : ""].filter(Boolean).join("; ")}${codeNote}`,
        });
      else {
        // Show what did run, so you can judge a test or deploy that ran in a way we do not recognise.
        const seen = [...new Set(shell.map((r) => `${r.byUser ? "(you) " : ""}${r.command.split("\n")[0]!.slice(0, 50)}`))].slice(0, 3);
        verdicts.push({
          ...v,
          verdict: "not done",
          why: `no sign of: ${missing.join(", ")}${seen.length ? `; commands seen: ${seen.join(" | ")}` : "; no commands ran in these turns"}`,
        });
      }
      continue;
    }

    if (files.length) {
      verdicts.push({ ...v, verdict: "done", why: `${files.length} file(s) changed in these turns are in the reviewed change (correctness not judged)` });
    } else if (edits.length && wantsCode) {
      verdicts.push({ ...v, verdict: "not in change", why: `${edits.length} edit(s) made in these turns, none of them in the reviewed change` });
    } else if (wantsCode && !wantsAnswer) {
      verdicts.push(
        answered
          ? { ...v, verdict: "needs judgment", why: "asked for a change, but only a reply was found; it may have been done outside this session" }
          : { ...v, verdict: "not done", why: "asked for a change; no edits, commands or reply in these turns" },
      );
    } else if (answered) {
      verdicts.push({
        ...v,
        verdict: wantsCode ? "needs judgment" : "answered",
        why: wantsCode ? "a reply, but no code change for a request that may need one" : "a substantive reply in these turns",
      });
    } else if (edits.length || shell.length) {
      verdicts.push({
        ...v,
        verdict: "needs judgment",
        why: `activity in these turns (${edits.length} edit(s), ${shell.length} command(s)) but nothing that settles it`,
      });
    } else {
      verdicts.push({ ...v, verdict: "not done", why: "no edits, commands or reply in these turns" });
    }
  }

  const extraFiles = [...(scope ?? new Map<string, FileScope>())].filter(([, s]) => s.kind === "drift").map(([p]) => p);
  const counts: Partial<Record<Verdict, number>> = {};
  for (const v of verdicts) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
  return { verdicts, extraFiles, counts };
}

/** Words every "don't touch" sentence shares; matching on them would tie every constraint to every violation. */
const CONSTRAINT_STOP = new Set(
  "dont don't touch touching change changing modify modifying edit editing never leave alone keep remove removing delete deleting code module modules file files this that these those without avoid make sure must should always please anything stuff part parts".split(
    " ",
  ),
);

/** A constraint like "don't touch payments" matches a file flagged against-instruction by the same words. */
function matchesConstraint(text: string, s: FileScope): boolean {
  if (!s.againstInstruction || !isFileConstraint(text)) return false;
  const words = (t: string) =>
    new Set(
      t
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !CONSTRAINT_STOP.has(w)),
    );
  const a = words(text);
  return [...words(s.againstInstruction.text)].some((w) => a.has(w));
}
