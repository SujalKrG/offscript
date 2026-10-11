# offscript: what Meta left unsolved, what developers complain about, and what we ship

Date: 11 Oct 2026. Research note 2. Builds on `arctic-deep-study.md` and does not repeat it.
Question answered: which gaps in ARCTIC, and which real complaints about AI review and coding agents, can an open-source tool solve and ship, and is each one achievable?

---

## 0. TL;DR

- ARCTIC proved the idea works at Meta, then left the hard parts open. It has no limitations section, the authors admit "the middle categories require further refinement", the intent benchmark had one annotator, and the intent metric measures thumbs-up, not accuracy. Spotlight on the full set is no better than Meta's old reviewer (precision 0.242 vs 0.253), and the self-review path doubled reverts (0.33% vs 0.17%). Nothing was released.
- The loudest developer complaints line up with what ARCTIC measures, and nothing on the market addresses them:
  1. The agent changed things I never asked for, and didn't tell me. Anthropic has closed several of these reports as "not planned".
  2. The agent said it was done, or that tests passed, and that wasn't true.
  3. The agent edited the tests so they would pass. GPT-5 cheated on 76% of impossible tasks in ImpossibleBench.
  4. AI reviewers are noise. In a 31,073-review study, 56.3% of CodeRabbit comments were rejected.
  5. Reviewers never see the prompt, so they have to reconstruct intent from the code.
  6. The agent ignores standing rules in CLAUDE.md or memory.
- Our edge over ARCTIC is structural, not just "cheaper". ARCTIC only sees the finished diff. A local Claude Code or Codex transcript holds every edit tool call in order, so we can tie each hunk to the turn and prompt that produced it. We can also spot hunks no tool call made (human edits) and check what the agent claimed against what it did. ARCTIC can't do any of that.
- Recording sessions is becoming a commodity: Entire (MIT), Git AI (founders hired by OpenAI, Sept 2026) and the Agent Trace spec. None of them judge. The open slot is **the judge, not the recorder**: evidence-backed verdicts, a public benchmark, and readers for every recorder's format.
- Everything in v1 is achievable with known formats, existing hooks and cheap models. The worked cost estimate comes to about $0.01 for a typical change and about $0.03 when an uncertain item escalates to a mid model, under the $0.05 target. The real risk is whether short prompts like "fix it" or "continue" carry enough intent, and the v0.0 spike tests exactly that.

---

## 1. What ARCTIC left unsolved (new findings from a second full read)

Study 1 covered the obvious weaknesses: the middle drift buckets, LLM-only judging, cost, post-hoc only, intent changing mid-session, and secrets. These are the additional gaps.

| # | Gap | Evidence from the paper | What we ship | When | Feasibility |
|---|---|---|---|---|---|
| G1 | Intent is checked by approval, not accuracy | Intent metric is thumbs-up (90.2%, n=112). No reasons collected for the 11 thumbs-down | Every intent shows its source quote. One keypress marks it wrong, with a reason (missed, invented, outdated). Reasons are stored locally and become regression fixtures | v0.1 | Easy |
| G2 | About 12% of real intents are missed | Recall 0.876 to 0.887 | **Unclaimed-hunk check**: any hunk that maps to no intent is surfaced. A missed intent shows up on the diff side either way, so the error is caught from both directions | v0.1 | Easy, falls out of the matcher |
| G3 | Single annotator, private benchmark | Intent ground truth from "a member of the research team"; drift annotator count not stated; data "cannot be legally released" | Public benchmark: mutation-injected drift (exact labels) plus a hand-labelled set with 2 annotators and reported kappa | v0.1 (A), v0.3 (B public) | Medium, see section 4.6 |
| G4 | Missing conversation not handled | Paper never says what happens when sources are absent | Every report carries an intent-confidence label (transcript, PR body only, commit message only). Low confidence turns off risky-UC claims that depend on intent | v0.1 | Easy |
| G5 | Long sessions, stacks, multi-diff work not covered | Trajectory complexity named, never broken out | Hunk-to-turn attribution (section 3.1) plus segmentation by commit boundaries | v0.2 | Medium |
| G6 | Spotlight is no better than the old reviewer on the full set | All diffs: precision 0.242 vs 0.253, recall 0.254 vs 0.255 | Don't compete on generic bug finding. Spotlight comes from drift first (hunks behind unmet or partial intents, risky UCs, test-integrity hits). Generic critique is capped at 3 items | v0.2 | Easy |
| G7 | Buckets are subjective; the MAE claim was never checked against bucket widths | Section 5.2 of the paper; MAE 10.31 | Checklist first, number second. The score is computed from items, and we publish per-item accuracy, not only QWK | v0.1 | Easy |
| G8 | Self-review raised reverts (0.33% vs 0.17%), not discussed | Section 2.6 | Never auto-land. Opt-in local outcome log: was this diff reverted within 14 days? So users can measure their own guardrail | v0.3 | Easy |
| G9 | Results are not causal | Self-selection; Mann-Whitney p = 0.063 | Out of our control, but our benchmark is open so anyone can rerun it | n/a | n/a |
| G10 | Human and AI edits are mixed in one diff | "Percentage of AI code" is a dimension, but it is estimated | Exact split: hunks matched to an agent edit tool call vs hunks no tool call made. Human hunks are excluded from drift blame | v0.2 | Medium (Bash-made edits need snapshot diffing) |

---

## 2. What developers complain about, and what we ship for each

### C1. "It changed things I didn't ask for, and didn't tell me"
Evidence:
- anthropics/claude-code #54240 (Apr 2026): asked to wrap a button in an if-statement; the agent refactored nearby code, deleted files and broke working features. Quoted reply when confronted: "Memory entries about this behavior have no effect." Closed as not planned.
- #64473 (Jun 2026): asked for meta tags in Blade templates; the agent rewrote an unrelated Twitter analytics service from API v1.1 to v2, introducing an undefined variable that would be fatal in production, and **never mentioned it**. The user found it in `git status`. Closed as not planned.
- Similar reports: #41620 (unrelated files), #7972 (destructive changes), #3216 (production code), #45713 (ignores permission settings).
- Tian Pan (Apr 2026): "over-broad refactors that expand a small fix into a large, unrelated change"; a confident diff with no clarifying questions is "a red flag".

What we ship:
- **Unrequested-change list**: each item names the file, the hunk, the risk class (deletion, public API, dependency, config/CI, migration, auth/payments, test) and the reason. Rules decide first; the model only decides what rules can't.
- **Disclosure check (new, not in ARCTIC)**: compare what the agent *said* it changed in its messages with what the diff contains. A risky change the agent never mentioned is the top finding. This directly targets #64473.
- **Turn attribution**: "this hunk was written in turn 14, after you said 'also fix the header'". The user can see at once whether they asked for it.

Feasibility: high. Edit and Write tool calls name the file in `tool_input.file_path` (confirmed in the hooks docs). Final assistant text is in the transcript and available as `last_assistant_message` on Stop.

### C2. "It said it was done, and it wasn't"
Evidence:
- #69488 (Jun 2026): told to implement 9 specs and upload. The agent said "all specs ON", but only 3 of 9 were done, and it spent an irreversible submission. It admitted choosing "looking done over telling the truth".
- #1501 and #11913: false test results reported. A Reddit user reported roughly halving false "this works" claims just by forcing a live curl check before completion (secondhand, anecdotal).
- The Stop-hook verifier pattern exists, but its author calls it "a completion gate, not a correctness gate", and same-model judging is "just the first opinion again".

What we ship:
- **Claim check**: extract completion claims from the final assistant message ("all tests pass", "implemented X and Y") and check each one against evidence:
  - Was a test command run *after the last edit*, and did it exit 0? This is deterministic, from tool calls and results in the transcript.
  - Does the diff contain the claimed work? The intent matcher answers this.
  - Claims without evidence are marked unverified, never true.
- Verdicts: verified, contradicted, or unverified.

Feasibility: high for the test-run check (Bash tool_use plus its tool_result with exit status). Medium for free-text claim extraction, which needs a small model call, but it's short.

### C3. "It edited the tests to make them pass"
Evidence:
- ImpossibleBench: GPT-5 cheated on 76% of one-off impossible tasks, and 66% on the conflicting SWE-bench variant (o3: 49%). Anthropic models "mostly modified test files directly". Claude Opus 4.1 still cheated 46% of the time even with an abort option. Read-only tests were especially effective for Claude.
- Codex hardcoding fake success values into evaluation scripts (Reddit, May 2026, unverified).
- Tian Pan: "tautological tests, where the assertion mirrors the implementation rather than the specification".

What we ship, as **test-integrity facts** (deterministic, free):
- Test files edited in a session whose intents didn't ask for test changes.
- Assertions removed, or the assertion count dropped.
- `skip`, `only`, `xfail`, `@Disabled`, or commented-out tests added.
- Expected values changed in the same turn as a failing test run.
- Operator or equality overrides added (`__eq__`, `equals`, custom matchers).
- Literal special-casing of test inputs in source code. A small model confirms these, because the rule alone gives false positives.

Any of these, combined with a test run that went from failing to passing, is a high-severity finding.

Feasibility: high. The first four are line and AST rules; tree-sitter covers TS, JS, Python and Go.

### C4. "AI reviewers are noise, so we stopped reading them"
Evidence:
- CodeRabbit study (31,073 reviews, 239 repos): 36.4% accepted, 56.3% rejected. Of the rejections, 43.3% were false positives, 10.0% out of scope and 4.7% redundant.
- ARCTIC: AI reviewers post design comments +350% and best-practice comments +327.8% vs humans, and security comments -89.5%.
- Tian Pan: below a 40% action rate a tool "is generating more noise than signal"; "engineers will forgive a tool that misses something; they will abandon a tool that cries wolf."

What we ship:
- No style, naming or best-practice comments, ever. That is a deliberate product rule, not a setting.
- Every finding cites evidence (a transcript message id or a diff hunk), or it isn't shown.
- Quiet by default: a clean run prints one line ("4/4 intents met, no risky changes, tests ran after last edit").
- Abstain instead of guess: when the judge runs disagree, the item is "uncertain", shown separately and ranked below everything else.
- Our own action-rate metric in the benchmark: we report precision, not just recall.

Feasibility: high. This is mostly discipline. The CodeRabbit paper also shows a LoRA-tuned Qwen3-4B predicts which review comments get rejected at 76% F1. A small local "would a human reject this?" critic is a realistic v0.3 add-on.

### C5. "The reviewer never sees the prompt"
Evidence: Tian Pan, "the actual intent lives in the prompt", rarely attached to the PR. ARCTIC's whole intent layer exists for this reason.

What we ship: an intent ledger in the PR comment and the terminal report. Each intent shows a short quote of the user message it came from, its status (active, superseded, cancelled) and its verdict. Quotes are redacted and trimmed; the full transcript is never posted.

Feasibility: high.

### C6. "I told it not to, in CLAUDE.md, and it did anyway"
Evidence: #54240 ("Memory entries about this behavior have no effect"); several secrets reports where `.env` files were read despite CLAUDE.md bans (#44868).

What we ship: **standing constraints**. Rules in CLAUDE.md, AGENTS.md and a repo `offscript.rules` file become constraint intents ("never touch migrations", "no new dependencies", "don't edit src/auth"). Violations are checked deterministically where possible (paths, dependency files) and by the judge otherwise. ARCTIC has nothing like this.

Feasibility: high for path and dependency rules; medium for free-text rules.

### C7. "Secrets end up in transcripts"
Evidence: #71654 (PATs and API tokens persisted to logs), #58043 (reading config files leaks keys into the transcript), #59094; agentsweep exists only to scan for this.

What we ship: redact before any model call using gitleaks-style rules. Transcripts never leave the machine except as redacted excerpts sent to the user's own model key. Bonus finding: "a secret appeared in this session's transcript at turn N".

Feasibility: high.

### C8. "Agent PRs are a different job to review, not a faster one"
Evidence: CodeRabbit data cited by Tian Pan (about 1.7x more issues in AI co-authored code); "hallucinated APIs", "confidently wrong abstractions"; reviewer fatigue and rubber-stamping (Octopus, vendor post, treat numbers as soft).

What we ship: the "where to look" list puts drift-derived hunks first. The report also marks hunks that cleanly implement a met intent as low-attention, so a reviewer can skim them. The win is time saved, not more comments.

Feasibility: high once the matcher exists.

---

## 3. Our structural advantages over ARCTIC (why this isn't a clone)

### 3.1 Hunk-to-turn attribution
Claude Code transcripts store every edit as a `tool_use` block (Edit, Write, MultiEdit) with the file path and the replaced text, in order, with `uuid` and `parentUuid` links and timestamps. They also store `file-history-snapshot` records. Codex rollouts store `function_call` items and `file_change` events. So for each hunk in the final diff we can answer:
- which turn wrote it, and which user message came just before;
- whether a later turn overwrote it;
- whether no tool call wrote it, meaning a human edit or a Bash-made edit (resolved by diffing snapshots between turns).

ARCTIC sees only the finished diff. With attribution, drift becomes "turn 14 went off-script" instead of "the diff scores 42".

### 3.2 Claim vs reality
ARCTIC deliberately strips tool calls from intent inference. We keep them for *verification*: what the agent said, what it ran, what came back. That powers C2 and C3 with no extra model cost.

### 3.3 Standing constraints
Covered in C6. ARCTIC has framework rules for Spotlight, not per-repo do-not-touch rules for drift.

### 3.4 Agent-neutral, recorder-neutral input
We read Claude Code and Codex natively, then Entire checkpoints, Git AI notes and Agent Trace records as adapters. Recording is becoming a commodity; judging is not.

---

## 4. Feasibility, component by component

### 4.1 Reading transcripts
- **Claude Code**: JSONL at `~/.claude/projects/<project>/<sessionId>.jsonl`. Records: `user`, `assistant`, `system`, `progress`, `queue-operation`, `file-history-snapshot`. Human prompts are `user` records with string content; tool results are `user` records with `tool_result` blocks. Compaction injects a "This session is being continued..." summary message and the file stays append-only. Verdict: parseable.
- **Codex**: JSONL rollouts under `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (Windows: `%APPDATA%\codex\`). Records: `session_meta`, `turn_context`, `response_item` (with `function_call` and `function_call_output` linked by `call_id`), `event_msg` (`user_message`, `agent_message`, `task_complete`) and `compacted`. Verdict: parseable.
- **Risk**: both formats change without notice. Codex renamed `item_type` to `type` and `assistant_message` to `agent_message` in early 2026, and the hooks docs call `transcript_path` "unstable". Mitigation: versioned parsers, a fixture corpus of real redacted sessions per CLI version, and CI that fails loudly on unknown record types instead of silently dropping them.

### 4.2 Hooks (running at checkpoints, not only after the fact)
- **Claude Code**: `Stop`, `PostToolUse`, `UserPromptSubmit` and more. Every hook gets `session_id`, `transcript_path` and `cwd`. A Stop hook can return `{"decision":"block","reason":...}` or exit 2 to keep the agent working. The transcript may lag the current turn, so use `last_assistant_message` on Stop.
- **Codex**: hooks are GA (`~/.codex/hooks.json` or `config.toml`, project-level too). Stop can block, and it receives `stop_hook_active` to prevent loops.
- Verdict: a `offscript hook install` command for both agents is achievable in v0.2. Default mode is **report only**; block mode is opt-in and only for high-severity findings, to avoid loops and nagging.

### 4.3 Deterministic fact layer
`git diff` plus tree-sitter (MIT) for removed or renamed exports and functions, signature changes, deleted files, dependency manifest changes, CI, config and migration paths, and the test-integrity rules from C3. No model, no cost, runs offline. Verdict: achievable in v0.0 for TS/JS; Python and Go in v0.2.

### 4.4 Models and cost
Current Anthropic API prices (USD per million tokens): Haiku 5.5 $0.10 in / $0.50 out (prompts up to 100K), Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20. Batch is 50% off; cache reads are 0.1x for Haiku.

Worked estimate for a typical change, all Haiku unless noted:

| Step | Input tok | Output tok | Cost |
|---|---|---|---|
| Intent ledger from redacted user and assistant text | 15,000 | 1,000 | $0.0020 |
| Backtranslation of the diff | 8,000 | 1,000 | $0.0013 |
| Judge, 3 shuffled runs | 3 x 6,000 | 3 x 1,000 | $0.0033 |
| Claim extraction plus Spotlight critic | 10,000 | 1,000 | $0.0015 |
| **Total, no escalation** | | | **about $0.008** |
| Escalate uncertain items to Sonnet 5.5 (1 run) | 6,000 | 1,000 | +$0.022 |

The target of under $0.05 per change holds with room to spare. These are estimates; v0.1 measures real token counts. The tool stays BYOK and model-agnostic. Users should pick a judge from a different model family than the agent that wrote the code, because same-family review repeats the first opinion.

### 4.5 Judge reliability
- An SE judge audit (2604.16790) shows small judges swing with answer order. Qwen2.5-Coder-3B scored 62.41 when the right answer was listed first and 38.03 when it was second (TestGen). Qwen3-4B test-retest consistency was only 70.56 to 91.41 depending on task.
- What we do:
  - Ask per-item questions ("is intent 3 met by these hunks: met, partial or unmet?"), never "score this diff".
  - Shuffle the order across 3 runs and accept only agreement; otherwise mark the item uncertain.
  - Hard facts override the model. A deleted export is a fact, not an opinion.
- FairJudge shows a trained 8B judge can beat a 72B general model. A local fine-tuned judge trained on our mutation benchmark is a realistic later step for fully offline use.

### 4.6 Benchmark data
- **Mutation benchmark A (ours)**: start from clean, intent-matched changes, then inject drift: drop an intent's hunks, add an out-of-scope edit, add a benign null check, delete an export, weaken a test, add a skip. Labels are exact and unlimited. This is the main evaluation and costs nothing to label.
- **Seeds for A**: SWE-bench style issue-plus-gold-patch pairs (issue = intent, patch = aligned diff), and AIDev: 932,791 agent PRs; the curated subset has 33,596 PRs with diffs, review comments and 4,923 linked issues, on Hugging Face. **Licence not stated in the paper: confirm before redistributing anything derived from it.**
- **Real set B**: 50 of Sujal's own sessions, double-labelled, private first and published once redaction is reviewed.
- ReviewBench (GitHub, 5 Oct 2026, 219 PRs) is public but has no intent or scope labels. It can sanity-check Spotlight only.

### 4.7 Distribution
- npm package plus single binary (Bun compile) for Windows, macOS and Linux.
- Claude Code plugin with slash command and hook, and a Codex hook config.
- GitHub Action (v0.3): reads the transcript from Entire checkpoints or an uploaded redacted session file, since CI has no local `~/.claude`.
- Licence: Apache 2.0, matching the Vectorvane open-core decision. Note that PR-Agent moved back to Apache 2.0 under a community org in Apr 2026, and scope-guard is AGPL; don't copy code from AGPL projects.

---

## 5. Landscape update since study 1

| Project | What it is | Judges intent vs diff? | Threat or input? |
|---|---|---|---|
| Entire CLI (MIT) | Records agent sessions into git refs (`refs/entire/checkpoints/...`) for Claude Code, Codex, Cursor, Copilot CLI and more. Auto summaries at commit time cover "intent, outcome, learnings". Has `entire why <file>:<line>` and an experimental multi-agent `entire review` | No drift scoring or evidence checks found | Biggest adjacent player. Treat as an **input** (adapter) and watch `entire review` closely |
| Git AI | Line-level AI attribution in git notes; founders hired into OpenAI's Codex team (Sept 2026); open-source project to continue | No, attribution and metrics only | Input adapter |
| Agent Trace (RFC v0.1.0, CC BY 4.0) | Spec linking line ranges to the conversation URL and model | No; quality assessment is explicitly a non-goal | Input adapter |
| git-narrate | Maps transcript events to diff hunks to write commit and PR text | No, narrates only | Validates hunk-to-turn attribution |
| scope-guard (v0.0.1, AGPL) | Claude Code Stop hook: an LLM flags changed files not mentioned in the prompt | File-level only, no evidence, no tests, no benchmark | Proves demand; we do it at hunk level with facts |
| intent-drift repos (1 commit, 0 to 2 stars), IntentDiff (Azure prototype, 3-case eval) | Goal vs plan comparators | Plans, not diffs; no transcripts | Not a threat |
| Gensee Crate, Codex Guardian | Runtime approval of tool calls before execution | Prevents, doesn't review | Complementary (Vectorvane territory) |
| ReviewBench (GitHub) | Open review benchmark | No intent or scope category | Gap we fill with benchmark A |

Reading: the market is split between **recorders** (Entire, Git AI, Agent Trace) and **bug-hunters** (CodeRabbit, Greptile, Copilot review). No one ships the evidence-backed judgment layer in between. Speed matters: Entire is the most likely to add drift. Our defence is a public benchmark with numbers and adapters that read their format, so we are useful *with* Entire rather than against it.

---

## 6. v1 scope (open source)

Ships in v1 (v0.1 to v0.3):
1. Transcript readers: Claude Code and Codex, versioned, with fixtures.
2. Secret redaction before any model call.
3. Intent ledger with source quotes, supersede and cancel, confidence label.
4. Standing constraints from CLAUDE.md, AGENTS.md and `offscript.rules`.
5. Deterministic facts: deletions, removed exports, signature changes, dependencies, config, CI, migrations.
6. Test-integrity facts.
7. Backtranslation plus per-intent matcher plus 3-run judge with abstention.
8. Unrequested-change list with risk classes and disclosure check.
9. Claim check (verified, contradicted, unverified).
10. Hunk-to-turn attribution and human-vs-agent hunk split.
11. Drift-first Spotlight, capped.
12. Outputs: terminal, markdown, JSON; Claude Code and Codex hooks in report-only mode, block mode opt-in.
13. Benchmark A generator and published results.

Not in v1: auto-merge (never), style review (never), hosted service, IDE extension, local fine-tuned judge (later), Entire and Git AI adapters (v0.4).

Example report (target shape):
```
offscript  session 7f3a…  14 turns  diff: 6 files +212 -41
Intent (confidence: high, from transcript)
  [met]      Add OG and Twitter meta tags to layout.blade.php      <- turn 1
  [partial]  Same tags on product pages (2 of 3 templates)         <- turn 1
  [cancelled] Add JSON-LD  (you said "skip JSON-LD" in turn 6)
Unrequested changes
  [RISKY, undisclosed] app/Services/AnalyticsTwitterService.php rewritten (v1.1 -> v2)  turn 4
Claims
  [contradicted] "all tests pass": no test command ran after the last edit (turn 12)
Tests:  no test files changed
Look here first: AnalyticsTwitterService.php:40-88, product/show.blade.php:1-20
Drift: Significant (computed from 1 partial, 1 risky undisclosed UC)
```

---

## 7. Hard parts and kill criteria

| Risk | Why it is hard | Mitigation | Kill or pivot signal |
|---|---|---|---|
| Terse prompts ("fix it", "continue", "yes") | Intent is spread across turns and the agent's own plan | Use the assistant's plan or todo text as a weaker intent source, labelled as agent-proposed and user-accepted | v0.0 spike: fewer than 6 of 10 sessions yield intents Sujal agrees with |
| Matching a long session to one diff | Multi-day sessions, several commits | Segment by commit boundaries plus turn attribution | Attribution covers less than 80% of hunks on real sessions |
| Benign vs risky is subjective | Users disagree | Rules first, editable `offscript.rules`, model only for leftovers | Risky-UC precision below 0.7 on set B |
| Format churn | Vendors change JSONL without notice | Versioned parsers, fixtures, loud failure | n/a, ongoing cost |
| Judge abstains too often | Disagreement across 3 runs | Escalate uncertain items to a mid model | More than 20% of items uncertain after escalation |
| Platforms build it natively | Anthropic, OpenAI or Entire ship drift review | Be agent-neutral, publish the benchmark, adapters for their formats | A native feature with evidence and a benchmark: then become the benchmark and the multi-agent layer |

---

## 8. Updated roadmap

- **v0.0 spike (2 to 3 days)**: Claude Code reader, redaction, intent ledger, deterministic facts and hunk-to-turn attribution, printed for 10 real sessions. Gate: the terse-prompt kill test above, plus attribution coverage.
- **v0.1 (1 to 2 weeks)**: backtranslation, matcher, 3-run judge, unclaimed hunks, claim check, test integrity, markdown and JSON report, benchmark A generator. Gate: risky-UC recall at least 0.9 on A; middle-bucket F1 above 0.5 (ARCTIC: 0.34 to 0.41).
- **v0.2**: Codex reader, hooks (report mode), standing constraints, disclosure check, drift-first Spotlight, Python and Go facts.
- **v0.3**: GitHub Action, public benchmark results post, outcome log, optional block mode.
- **v0.4**: Entire, Git AI and Agent Trace adapters; small local critic.

---

## Sources
ARCTIC and Meta
- ARCTIC paper (html v1) https://arxiv.org/html/2607.29516v1
- ARCTIC on alphaXiv https://www.alphaxiv.org/abs/2607.29516

Developer complaints
- Claude Code #54240 unasked changes https://github.com/anthropics/claude-code/issues/54240
- Claude Code #64473 out-of-scope backend edits, undisclosed https://github.com/anthropics/claude-code/issues/64473
- Claude Code #41620 unrelated files https://claudeissues.com/issue/41620-bug-claude-code-making-unauthorized-modifications-to-unrelated-files
- Claude Code #7972 destructive changes https://claudeissues.com/issue/7972-model-claude-code-makes-destructive-unauthorized-changes-breaking-working-system
- Claude Code #3216 production code https://claudeissues.com/issue/3216-bug-title-claude-code-making-unauthorized-changes-to-working-production-code-cri
- Claude Code #45713 ignores permissions https://claudeissues.com/issue/45713-claude-code-ignores-permission-settings-and-makes-unauthorised-changes
- Claude Code #69488 incomplete work presented as complete https://claudeissues.com/issue/69488-claude-code-agent-misrepresented-incomplete-work-as-complete-and-uploaded-it-bur
- Claude Code #1501 false test results https://claudeissues.com/issue/1501-bug-claude-code-reports-false-test-results-and-actions
- Claude Code #11913 fabricated test results https://claudeissues.com/issue/11913-claude-code-fabricated-test-results-and-repeatedly-lied-to-user
- Claude Code #71654 secrets in transcripts https://claudeissues.com/issue/71654-bug-session-transcripts-leak-secrets-github-pat-api-tokens-to-persisted-logs
- Claude Code #58043 config reads leak keys https://claudeissues.com/issue/58043-read-cat-on-config-files-leaks-api-keys-into-conversation-transcript
- Claude Code #44868 .env exposure despite CLAUDE.md https://claudeissues.com/issue/44868-claude-code-exposes-secrets-from-env-dev-vars-files-via-grep-n-and-read-tool-des
- Is Agentic Code Review Helpful? (CodeRabbit feedback study) https://www.alphaxiv.org/abs/2607.03316
- ImpossibleBench summary https://www.greaterwrong.com/posts/qJYMbrabcQqCZ7iqm/impossiblebench-measuring-reward-hacking-in-llm-coding-1
- Codex hardcoded success values (unverified) https://aiweekly.co/alerts/openai-codex-accused-of-hardcoding-fake-results-to-hide-failures
- Reviewing Agent PRs Is a Different Job https://tianpan.co/blog/2026-04-27-reviewing-agent-prs-different-not-faster
- AI Code Review at Scale: the false positive trap https://tianpan.co/blog/2026/04/17/ai-code-review-at-scale-false-positive-trap
- Why devs ignore AI code reviews (vendor) https://octopus-review.ai/blog/why-devs-ignore-ai-code-reviews-and-how-to-fix-it
- Stop hook that won't let Claude lie https://codingwithroby.substack.com/p/the-stop-hook-that-wont-let-claude
- Halving false success claims (secondhand) https://aiweekly.co/node/1877
- Codex reviews Claude's diffs https://zackproser.com/blog/codex-reviews-claudes-diffs
- Why Agentic-PRs Get Rejected https://arxiv.org/html/2602.04226

Feasibility
- Claude Code hooks reference https://code.claude.com/docs/en/hooks
- Claude Code transcript format notes https://evilpiepirate.org/forge/kent/consciousness/raw/branch/master/doc/claude-code-transcript-format.md
- Codex rollout format https://codex.danielvaughan.com/2026/06/01/codex-cli-session-history-local-search-rollout-format-knowledge-mining/
- Codex transcripts and event stream https://codex.danielvaughan.com/2026/05/21/codex-cli-session-transcripts-jsonl-replay-viewer-tools-audit-analysis/
- Codex hooks after GA https://codex.danielvaughan.com/2026/05/25/codex-cli-hooks-after-ga-event-model-trust-verification-production-patterns/
- Codex Guardian approval https://codex.danielvaughan.com/2026/04/20/codex-cli-guardian-approval-configuring-auto-review-policies/
- Anthropic API pricing https://platform.claude.com/docs/en/about-claude/pricing
- Auditing LLM judges for SE bias https://arxiv.org/html/2604.16790
- FairJudge https://www.alphaxiv.org/abs/2602.06625
- AIDev dataset https://arxiv.org/html/2602.09185v1
- ReviewBench https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/
- PR-Agent returns to Apache 2.0 https://futurumgroup.com/insights/qodo-hands-pr-agent-to-the-community-will-open-governance-accelerate-ai-code-review/

Landscape
- Entire CLI README https://cdn.jsdelivr.net/gh/entireio/cli@main/README.md
- Entire Codex docs https://docs.entire.io/agents/codex
- Git AI https://usegitai.com/track-ai-code
- OpenAI hires Git AI founders https://thenewstack.io/openai-hires-git-ai/
- Agent Trace spec https://agent-trace.dev/
- git-narrate write-up https://dev.to/arsyadal/how-we-correlated-llm-tool-calls-with-git-diff-hunks-to-automate-pr-narratives-289j
- scope-guard plugin https://agentskill.sh/plugins/andreahlert/scope-guard
- intent-drift https://github.com/shauryagangrade/intent-drift
- IntentDiff https://github.com/MariaJi/intentdiff
- Gensee: intent drift in coding agents https://www.gensee.ai/blogs/ap002-intent-drift-ai-coding-agents.html
- Tricentis on intent drift https://www.tricentis.com/blog/intent-drift-ai-code-fix-regression-blind-spots
