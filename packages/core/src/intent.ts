// Intent ledger: what the user asked for, from the conversation only.
// Leakage rule (from ARCTIC): this stage never sees the diff.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheKey, getCached, putCached } from "./cache.ts";
import { judgeModel, runClaudeJson } from "./judge/claude-cli.ts";
import { redact } from "./redact.ts";
import type { Claim, Intent, IntentLedger, Session } from "./types.ts";

const MAX_PROMPT_CHARS = 2500;
const MAX_TOTAL_CHARS = 60_000;

export const INTENT_SYSTEM = `You extract the user's intents from a coding-agent session for a review tool.
You see only what the USER typed (numbered prompts), the repo's standing rules file if any, and the agent's final message. You never see code.

Rules:
- An intent is WHY the user wanted a change, written as one short imperative sentence ("Add OG meta tags to the product pages so links preview on social media").
- kind: "task" (something to build or change), "constraint" (something NOT to do or a limit, e.g. "don't touch auth", "no new dependencies"), "preference" (style or approach wishes).
- Standing rules from the rules file are constraints; give them sourcePrompts [0].
- Track changes of mind: if a later prompt cancels or replaces an earlier intent, mark the earlier one "cancelled" or "superseded" and set supersededBy to the new intent id.
- Short replies like "yes", "go ahead", "continue" add no intent unless they accept a specific proposal; if the user accepts an agent proposal, write the intent from what was accepted and say so in the quote.
- quote: copy at most 120 characters from the source prompt, verbatim.
- Do not invent intents. If the prompts are too vague to know what was wanted, return fewer intents and set confidence to "low".
- claims: completion claims in the agent's final message, e.g. "all tests pass" (type "tests_pass"), "implemented X" ("implemented"), "fixed Y" ("fixed"), else "other". Empty list if none.

Return ONLY a JSON object, no prose, exactly this shape:
{"intents":[{"id":"I1","text":"...","kind":"task","sourcePrompts":[1],"quote":"...","status":"active","supersededBy":null}],"claims":[{"text":"...","type":"tests_pass"}],"confidence":"high","notes":"one sentence on anything ambiguous"}`;

function readRules(repo: string): string {
  for (const name of ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"]) {
    const p = join(repo, name);
    if (existsSync(p)) {
      const t = readFileSync(p, "utf8").slice(0, 4000);
      return `--- ${name} (first 4000 chars) ---\n${redact(t).text}`;
    }
  }
  return "(no CLAUDE.md or AGENTS.md)";
}

export function buildIntentInput(session: Session, repo: string): string {
  const prompts = session.prompts.map((p) => {
    const t = p.text.length > MAX_PROMPT_CHARS ? `${p.text.slice(0, MAX_PROMPT_CHARS)} [...truncated]` : p.text;
    return `[${p.index}] ${t}`;
  });
  // Keep the first and the most recent prompts if the session is huge.
  let body = prompts.join("\n\n");
  if (body.length > MAX_TOTAL_CHARS) {
    const head: string[] = [];
    const tail: string[] = [];
    let size = 0;
    let i = 0;
    let j = prompts.length - 1;
    let takeHead = true;
    while (i <= j) {
      const next = takeHead ? prompts[i]! : prompts[j]!;
      if (size + next.length > MAX_TOTAL_CHARS) break;
      if (takeHead) {
        head.push(next);
        i++;
      } else {
        tail.unshift(next);
        j--;
      }
      size += next.length;
      takeHead = !takeHead;
    }
    body = `${head.join("\n\n")}\n\n[... middle prompts omitted for length ...]\n\n${tail.join("\n\n")}`;
  }
  const last = session.assistant[session.assistant.length - 1]?.text ?? "(none)";
  return [
    "USER PROMPTS (numbered, in order):",
    body || "(none)",
    "",
    "STANDING RULES FILE:",
    readRules(repo),
    "",
    "AGENT'S FINAL MESSAGE (for claims only):",
    last.slice(0, 2000),
  ].join("\n");
}

function asIntents(v: unknown): Intent[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object" && typeof (x as any).text === "string")
    .map((x: any, i) => ({
      id: typeof x.id === "string" ? x.id : `I${i + 1}`,
      text: String(x.text),
      kind: ["task", "constraint", "preference"].includes(x.kind) ? x.kind : "task",
      sourcePrompts: Array.isArray(x.sourcePrompts) ? x.sourcePrompts.map(Number).filter((n: number) => Number.isFinite(n)) : [],
      quote: typeof x.quote === "string" ? x.quote.slice(0, 160) : "",
      status: ["active", "superseded", "cancelled"].includes(x.status) ? x.status : "active",
      supersededBy: typeof x.supersededBy === "string" ? x.supersededBy : null,
    }));
}

function asClaims(v: unknown): Claim[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === "object" && typeof (x as any).text === "string")
    .map((x: any) => ({
      text: String(x.text).slice(0, 200),
      type: ["tests_pass", "implemented", "fixed", "other"].includes(x.type) ? x.type : "other",
    }));
}

export function buildIntentLedger(session: Session, repo: string, useModel: boolean, timeoutMs?: number): IntentLedger {
  if (!useModel) {
    return { intents: [], claims: [], confidence: "low", notes: "model disabled (--no-llm)", backend: "none", costUsd: null, error: null };
  }
  if (session.prompts.length === 0) {
    return { intents: [], claims: [], confidence: "low", notes: "no human prompts in session", backend: "none", costUsd: null, error: null };
  }
  const r = runClaudeJson({
    system: INTENT_SYSTEM,
    input: buildIntentInput(session, repo),
    timeoutMs,
    validate: (v: any) => ({
      intents: asIntents(v?.intents),
      claims: asClaims(v?.claims),
      confidence: (["high", "medium", "low"].includes(v?.confidence) ? v.confidence : "low") as IntentLedger["confidence"],
      notes: typeof v?.notes === "string" ? v.notes : "",
    }),
  });
  if (!r.ok || !r.value) {
    return { intents: [], claims: [], confidence: "low", notes: "", backend: `claude-cli (${r.attempt})`, costUsd: r.costUsd, error: r.error };
  }
  return { ...r.value, backend: `claude-cli haiku (${r.attempt})`, costUsd: r.costUsd, error: null };
}

/** Bump when INTENT_SYSTEM or the ledger shape changes, so old cache entries stop matching. */
export const INTENT_PROMPT_VERSION = 1;

/**
 * The model ledger behind a content-addressed cache. The key covers the model, the system prompt, the numbered
 * prompts, the rules file and the agent's final message (all of buildIntentInput), so a changed prompt misses.
 * Only clean results are stored: a failed call is retried next time.
 */
export function cachedIntentLedger(session: Session, repo: string, timeoutMs?: number): { ledger: IntentLedger; hit: boolean } {
  if (session.prompts.length === 0) return { ledger: buildIntentLedger(session, repo, true, timeoutMs), hit: false };
  const key = cacheKey(`v${INTENT_PROMPT_VERSION}`, judgeModel(), INTENT_SYSTEM, buildIntentInput(session, repo));
  const stored = getCached(key) as Partial<IntentLedger> | null;
  if (stored && Array.isArray(stored.intents)) {
    const ledger: IntentLedger = {
      intents: asIntents(stored.intents),
      claims: asClaims(stored.claims),
      confidence: (["high", "medium", "low"].includes(String(stored.confidence)) ? stored.confidence : "low") as IntentLedger["confidence"],
      notes: typeof stored.notes === "string" ? stored.notes : "",
      backend: `${typeof stored.backend === "string" ? stored.backend : "claude-cli"}, cached`,
      costUsd: null,
      error: null,
    };
    return { ledger, hit: true };
  }
  const ledger = buildIntentLedger(session, repo, true, timeoutMs);
  if (!ledger.error) putCached(key, ledger);
  return { ledger, hit: false };
}

// A reply that only moves the conversation along ("yes", "go ahead", "continue"): it asks for nothing new.
const FOLLOW_UP_RE =
  /^(?:(?:yes|yep|yeah|yup|ok|okay|sure|please|go ahead|go on|continue|proceed|do it|sounds good|looks good|lgtm|thanks|thank you|thx|great|nice|perfect|next|keep going|try again|retry|that works|correct|right|exactly)(?:[\s,]+|$))+$/;
const CONSTRAINT_RE = /^(?:please\s+)?(?:don'?t|do not|never|no new|without|avoid|stay away|leave\b)/i;

export function isFollowUp(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,\s]+$/, "");
  return t.length === 0 || FOLLOW_UP_RE.test(t);
}

/**
 * Offline ledger for --no-llm: one request per prompt that is not a follow-up. Crude on purpose (a prompt with
 * three asks stays one request) but free, instant and deterministic.
 */
/** Harness and meta prompts that are not requests: interrupt markers, slash-command wrappers, caveats, local command output. */
const META_PROMPT_RE = /^\s*(?:\[Request interrupted|<command-|<local-command-|Caveat:)/i;

export function isMetaPrompt(text: string): boolean {
  return META_PROMPT_RE.test(text);
}

export function heuristicLedger(session: Session): IntentLedger {
  const intents: Intent[] = [];
  for (const p of session.prompts) {
    if (isMetaPrompt(p.text) || isFollowUp(p.text)) continue;
    const flat = p.text.replace(/\s+/g, " ").trim();
    const first = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
    intents.push({
      id: `I${intents.length + 1}`,
      text: first.length > 160 ? `${first.slice(0, 157)}...` : first,
      kind: CONSTRAINT_RE.test(flat) ? "constraint" : "task",
      sourcePrompts: [p.index],
      quote: flat.slice(0, 120),
      status: "active",
      supersededBy: null,
    });
  }
  return {
    intents,
    claims: [],
    confidence: "low",
    notes: "offline heuristic: one request per prompt (--no-llm)",
    backend: "heuristic",
    costUsd: null,
    error: null,
  };
}
