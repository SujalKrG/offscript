# ARCTIC deep study: Meta's intent, drift and spotlight system, reverse engineered

Tool name (decided 12 Oct 2026): **offscript**. Earlier notes call it "drift reviewer".

Date: 11 Oct 2026. Private. Author: Sujal (research compiled with Claude).
Paper: "From Code Review to Code Critique: Intent, Drift, and Spotlight for AI-Generated Diffs at Scale", arXiv 2607.29516 (v2).
Authors: Chandra Maddila, Mashrur Rashik, Euna Mehnaz Khan, Smriti Jha, James Saindon, Nachiappan Nagappan (Meta), Peter C. Rigby (Meta and Concordia University).
Code and data: NOT released ("data cannot be released due to employee contract law"). No public tool exists.

---

## 0. TL;DR

- ARCTIC is Meta's internal system for reviewing AI-generated code changes. Instead of line-by-line review comments, it answers three questions for every diff:
  1. Intent: WHY was this change made? (inferred from the agent conversation, not the code)
  2. Drift: did the code actually do what was intended, and did it do things nobody asked for?
  3. Spotlight: which few regions of the diff deserve a human's attention?
- It is served as an API (1M+ requests) and powers a "self-review then land" path where low-drift diffs can land without waiting for a peer reviewer.
- Strong points: intent F1 0.86, drift agreement with humans QWK 0.907, Spotlight 2.4x better than Meta's previous AI reviewer with 5x fewer tokens, intent approved 90.2% by developers, showing the drift score made authors reduce drift by 5.76 extra points.
- Weak points we can fix: the middle drift scores are unreliable (Moderate bucket F1 0.34, bucket accuracy 64%), everything is LLM-judged with no deterministic facts, Spotlight precision and recall are low in absolute terms (about 0.10 on problematic diffs), it runs only after the diff is finished, it uses Opus for everything, and nobody outside Meta can use or reproduce it.
- Opportunity: an open-source, cheap, local-first drift reviewer for Claude Code and Codex sessions. The raw ingredient ARCTIC needs most (the agent conversation) sits on every developer's disk as JSONL transcripts. Nobody uses it for review today.

---

## 1. Why Meta built it (context)

- Code is being produced faster than humans can review it. Meta's companion paper (RADAR, arXiv 2605.30208) reports +105.9% year-over-year lines of code per human-landed diff and +51% diffs per developer, with over 80% of the growth attributed to agentic AI.
- Existing AI reviewers comment on the wrong things. ARCTIC's own measurement (section 3.2 below): AI reviewers over-produce style and design comments and under-produce correctness, security and performance comments.
- "Agentic drift" had no detector. An agent can produce clean-looking code that quietly does something other than what the developer meant, or more than they meant.
- Framing shift in the title: from "code review" (judge lines) to "code critique" (judge whether the change is the right change, then point attention).

Related Meta systems (same research group), useful to understand the ecosystem ARCTIC lives in:
- RADAR (2605.30208): risk-aware auto review and landing. Diff Risk Score percentile gates (P5 for human diffs, P20 bots, P50 allowlisted runbooks), LLM review confidence at least 8/10, 535K+ diffs reviewed, 331K+ landed, reverts about 1/3 and production incidents about 1/50 of non-RADAR diffs (observational).
- Wink (2602.17037): watches coding-agent trajectories live, classifies misbehaviors (Specification Drift, Reasoning Problems, Tool Call Failures), injects corrections. About 30% of production trajectories had at least one misbehavior; 90% resolved with one intervention; 5.3% fewer tokens; 4.2% fewer engineer interventions.
- AI-Assisted Fixes to Code Review Comments at Scale (2507.13499, FSE 2026 industry).
- Older lineage: Nudge (overdue PRs), WhoDo (reviewer recommendation), Diff Risk Score.
Takeaway: Wink fights drift DURING the session, ARCTIC detects drift AFTER the diff, RADAR decides who must review. Outside Meta, none of the three exist as usable tools.

---

## 2. Core concepts and definitions (the "rules" of ARCTIC)

- Intent = why a change was made. Explicitly NOT a summary of what changed. ("a summary describes what was changed, whereas an intent explains why it was changed")
- Drift = divergence between inferred intent and the diff. Two kinds:
  - DNF, Did Not Follow: the agent failed to comply with explicit instructions or implied intent.
  - UC, Unrequested Changes: extra changes nobody asked for. Beneficial ones (e.g. adding a missing null check) are NOT penalized. Only risky or clearly out-of-scope ones are (scope creep, touching sensitive files, deleting functionality, breaking changes).
- Forest view vs trees view: forest = intent, milestones of the agent trajectory, drift. Trees = ranked regions of code that need a human.
- Change gradient: six dimensions that change which intent sources are trustworthy for a given diff:
  1. commit type (bug fix leans on the task; feature leans on requirement doc and AI plan)
  2. human-in-the-loop vs headless agent run
  3. percentage of AI-authored code
  4. who wrote the diff metadata (human or AI)
  5. trajectory complexity
  6. which sources are available at all
- Leakage rule: the code diff is EXCLUDED when inferring intent (avoids circular reasoning), and intent sources (summary, test plan, trajectory) are EXCLUDED when backtranslating the diff (avoids biasing drift).
- Severity-first rule for Spotlight: correctness, security, performance outrank style; style nits are deliberately suppressed.

---

## 3. Components, reverse engineered

### 3.1 Review taxonomy (the foundation)
Built from 18,000 human-reviewed diffs (Meta's CR2 dataset) plus 712 curated AI reviews that humans acted on. Method: LLM theme extraction, 40 rounds of LLM pairwise consolidation, manual validation by two researchers. A multi-label LLM tagger then classifies any review comment.

| Theme | Share of human review comments |
|---|---|
| Correctness and Reliability | 44.4% |
| Code Quality and Maintainability | 19.2% |
| Security | 19.1% |
| Best Practices and Standards | 7.2% |
| Performance and Efficiency | 6.6% |
| Code Design | 3.6% |

### 3.2 The AI review gap (why existing AI reviewers fail)
2,000 sampled AI review comments tagged with the taxonomy, relative difference vs humans:

| Theme | AI vs human |
|---|---|
| Correctness | -42.6% |
| Security | -89.5% |
| Performance | -59.1% |
| Code Quality | +19.3% |
| Best Practices | +327.8% |
| Code Design | +350.0% |

Reading: AI reviewers talk 3-4x too much about style and design and far too little about what breaks things. This is the single most quotable finding in the paper.

### 3.3 Intent prediction
- Inputs: developer and agent conversation (messages only, tool calls stripped), diff metadata (title, summary, test plan), AI-generated plans (plan mode), linked artifacts (requirement docs, tasks, markdown files). Diff excluded.
- Two variants, both Opus 4.5:
  - Zero-shot: one prompt, all context, extract intents in one pass.
  - Agentic: multi-turn loop with tool calls to fetch more context and refine intents. Tools not named.
- Output: a list of intents (why-statements).
- Benchmark: 121 AI-generated diffs with hand-written ground-truth intents. Judge: LLM pairwise semantic similarity, match threshold 0.5.

| Metric | Agentic | Zero-shot |
|---|---|---|
| Precision | 0.880 | 0.846 |
| Recall | 0.876 | 0.887 |
| F1 | 0.860 | 0.844 |
| Jaccard | 0.698 | 0.645 |
| Semantic similarity | 0.772 | 0.768 |
| Tokens | 52,191 | 8,089 |
| Runtime | 52.3 s | 22.6 s |

Key insight: the agentic version costs 6.4x the tokens for +0.016 F1. Zero-shot is the right default. Our reconstruction should be zero-shot with a cheaper model.

### 3.4 Drift detection by backtranslation
Pipeline (reconstructed):
1. Intent list from 3.3.
2. Backtranslation agent reads ONLY the diff and writes a numbered list of tasks the diff actually performs ("what this code does, as if it were the instructions").
3. Zero-shot LLM compares intent list vs backtranslated task list and scores two dimensions: intent satisfaction (fully / partially / unmet per intent) and unrequested changes (benign vs risky).
4. Output: 0-100 drift score, bucket label, itemized satisfied goals and gaps.

Rubric (same for humans and model):
| Bucket | Score | Meaning |
|---|---|---|
| Perfect Alignment | 0-10 | all intents fully satisfied, no bad unrequested changes |
| Minor Drift | 11-25 | all intents satisfied, only trivial deviations |
| Moderate Drift | 26-50 | most intents addressed, some partial, and/or noticeable bad UCs |
| Significant Drift | 51-75 | only some intents satisfied, and/or substantial risky UCs |
| Major Drift | 76-100 | no intents satisfied, near-complete deviation, and/or severe UCs (deleting functionality, breaking changes) |

Benchmark: 118 diffs, human-scored, 18-31 per bucket.

| Metric | Value |
|---|---|
| Quadratic weighted kappa (QWK) | 0.907 |
| Linear weighted kappa | 0.776 |
| Exact bucket accuracy | 64.4% |
| Mean absolute error (0-100) | 10.31 |

Per-bucket F1: Perfect 0.889, Minor 0.667, Moderate 0.341, Significant 0.409, Major 0.812.
Reading: it reliably tells "clean" from "badly off", which is what QWK rewards. It is poor at the middle, which is exactly where real review decisions are hard.

### 3.5 Code Spotlight
- Non-agentic, two LLM passes, Opus 4.5.
- Inputs: diff title, summary, full contents of modified files, framework rules (house rules per framework).
- Pass 1 (generate): triage the diff across five categories and propose candidate regions.
- Pass 2 (critic): keep a region only if it passes all of: claim is correct, consistent with intent, consistent with framework rules, the comment is actionable, and it meets a "senior engineer would care" bar.
- Output per region: category, severity (error / warning / information), actionable rationale. Top few shown, ordered by severity.
- Benchmark CRBench: about 300 diffs from a 60-day window, 70% problematic / 30% clean, ground truth filtered to actionable comments a reviewer could determine from the diff alone.

| System | Slice | QE | DL pass@5 | Precision | Recall | Tokens | Time to first result |
|---|---|---|---|---|---|---|---|
| Old AI reviewer | Problematic (208) | 0.239 | 0.030 | 0.036 | 0.033 | 417,849 | 335.9 s |
| Spotlight | Problematic (208) | 0.582 | 0.098 | 0.108 | 0.097 | 84,757 | 55.4 s |
| Old AI reviewer | All (298) | 0.454 | 0.048 | 0.253 | 0.255 | 417,849 | 335.9 s |
| Spotlight | All (298) | 0.594 | 0.103 | 0.242 | 0.254 | 84,757 | 55.4 s |

Reading: about 2.4x quality estimate, 3.3x defect localization, 5x fewer tokens, 6x faster. But absolute precision and recall on problematic diffs are about 0.10: it finds roughly 1 in 10 real problems. The critic pass is the clever part (it kills noise); the generator is still weak.

### 3.6 Diff categorization
Mentioned as a fourth served signal; no details given.

---

## 4. Product, rollout and governance (spring 2026)

Rollout stages:
1. Intent shown in the normal diff view, with thumbs up/down.
2. Drift shown in a redesigned "Diff-Next" view.
3. Bundle (Intent + Drift + Spotlight) as opt-in early access.
4. SDR enablement: diffs that pass quality checks may land without upfront peer review (review deferred).

Funnel: diff created -> ARCTIC computes signals -> eligible diffs offered self-review -> author attests -> lands on streamlined path, or goes to deferred peer review.

Metrics they chose (worth copying):
- Goal: Intent Approval Rate, Drift Reduction When Shown.
- Adoption: Attestation-to-Land Rate, Eligibility-to-Attestation Conversion.
- Guardrails: Defect Attribution, Revert Rate.

Results:
- Intent approval 90.2% (101 up, 11 down, n=112).
- Drift falls across diff versions: mean -11.82 points over 193 version pairs (p < 0.0001, d = -0.58); 75.9% of changed pairs decreased.
- Showing the score helps: authors who saw it reduced drift 5.76 points more (n=94 vs 99, one-sided p = 0.026, d = -0.28; Mann-Whitney p = 0.063, i.e. borderline).
- Adoption, late spring: 124 weekly viewers, 78 attestations a week, 76% of attested diffs land via the streamlined path, 37% eligibility-to-attestation.
- Guardrails: 0 defects attributed to self-reviewed diffs; revert rate 0.33% vs 0.17% baseline (about 2x, small numbers, but the paper does not discuss it).
- Scale: 1M+ API requests.

UI (mock in the paper): left Intent Summary; centre Intent Drift panel (score, label, satisfied goals, gaps); below that Code Spotlight ranked regions; then Key Milestones of the agent trajectory; then classic file-by-file diff at the bottom. Low drift and no spotlight findings -> attest and land. Otherwise -> fix gaps first.

---

## 5. Advantages (what to keep)

1. Right question first: "is this the change you wanted?" before "is each line fine?". Humans review faster when intent is clear.
2. Intent from conversation, not from code: uses the information the code cannot contain.
3. Leakage discipline: intent never sees the diff, backtranslation never sees the intent sources. Simple, important, easy to copy.
4. Benign vs risky unrequested changes: avoids punishing agents for good extra fixes.
5. Critic pass: a second model call that throws away weak findings is the main reason Spotlight beats the old reviewer with fewer tokens.
6. Severity-first, style-last: directly corrects the measured AI review gap.
7. Measured like a product: approval rate, drift-when-shown, revert guardrail, staged rollout.
8. Modular API: each signal usable alone.

---

## 6. Issues and gaps, and how we fix each

| # | Issue in ARCTIC | Evidence | Our fix |
|---|---|---|---|
| 1 | Middle drift buckets unreliable | Moderate F1 0.341, Significant 0.409, bucket accuracy 64.4% | Do not ask an LLM for a 0-100 number. Ask per-intent verdicts (satisfied / partial / unmet) each with an evidence hunk, plus a list of unrequested changes each classified. Compute the score deterministically from those items. Report the itemized checklist first, the number second. |
| 2 | Everything is LLM judgment, no hard facts | Rubric, backtranslation, judge all LLM | Deterministic fact layer runs first and is never overridden: files deleted, functions or exports removed, public API signature changes, dependency added/removed, config/CI/migration touched, test files changed, assertions removed, lines deleted outside the intent's files. These facts feed the judge and gate UC risk by rule. |
| 3 | LLM-as-judge bias | SE judge audits show position and verbosity effects of 10-30 points and test-retest consistency as low as 50-71% (2604.16790) | Run the judge 3 times with shuffled item order; accept a verdict only if runs agree; otherwise mark "uncertain" and escalate (bigger model or human). Neutral templates. Conformal threshold on agreement. Fall back to executable checks (tests) when uncertain. |
| 4 | Drift low does not mean correct | Drift measures alignment, not bugs; Spotlight finds about 1 in 10 problems | Attach verification evidence: did tests actually run after the last edit, did they pass, were test files or assertions changed (integrity check). "Aligned + verified" is the only green. |
| 5 | Post-hoc only | Runs on the finished diff | Run drift at checkpoints during the session (turn end, before commit, before push). Drift is cheapest to fix while the agent still has context. This is exactly what Vectorvane needs at night. |
| 6 | Intent changes during a session | Late requirements roughly double code invalidation (2609.03028) | Intent ledger with time: each intent has a source message and timestamp; later messages can supersede or cancel earlier ones ("actually skip the admin panel"). Drift is judged against the CURRENT intent set, with superseded intents shown as such. |
| 7 | Expensive | Opus 4.5 everywhere; Spotlight 85K tokens, agentic intent 52K | Zero-shot intent (8K tokens in the paper) on a small model; backtranslation per file chunk on a small model; judge on a mid model only for flagged items; deterministic facts free. Target under $0.05 and under 30 s per typical diff. Cache the stable system prompt. |
| 8 | Not reproducible, no public benchmark | Data not released | Build an open benchmark (see section 9): mutation-based drift injection gives exact labels for free. |
| 9 | Self-review may raise reverts | 0.33% vs 0.17% revert rate, not discussed | Never auto-land on our side by default. Our output is advice plus a gate the user configures. Track our own revert guardrail in dogfood. |
| 10 | Benign vs risky UC is subjective | Rubric wording only | Rule-based risk classes first (sensitive paths, deletions of existing behaviour, public API, deps, CI, migrations, auth/payments, tests), LLM only for the rest. User-editable scope rules per repo. |
| 11 | Needs rich conversation; headless runs have little | Change gradient discussion | Claude Code and Codex transcripts are complete on disk: user messages, plan mode, todo lists (TodoWrite), CLAUDE.md, linked issue. We have more intent signal than ARCTIC in most solo-dev cases. For diffs with no transcript, fall back to commit message, PR body, linked issue, and say "low intent confidence". |
| 12 | Transcripts contain secrets | Agents store pasted secrets in plaintext history (agentsweep findings) | Redact before any model call (gitleaks-style rules), local-first, bring-your-own model key. |
| 13 | Scores can cause rubber-stamping | Cognitive surrender, intent debt (Storey 2026) | Show gaps and evidence, not just a number. Require the reviewer to look at the top Spotlight item before "attest" in the optional gate. |
| 14 | Spotlight category mismatch (5 categories vs 6 themes) and modest recall | Paper | Use the 6-theme taxonomy explicitly; add intent-aware rule: regions implementing an "unmet" or "partial" intent, and regions with risky UCs, are always spotlighted first. Those are the highest-yield regions and cost nothing extra to find. |

---

## 7. Landscape: who does what today

| Tool | Intent from agent conversation | Drift score | Unrequested-change detection | Ranked regions | Open source | Notes |
|---|---|---|---|---|---|---|
| ARCTIC (Meta) | Yes | Yes | Yes | Yes | No, internal | the reference design |
| Wink (Meta) | Live, during trajectory | Spec-drift class | No | No | No, internal | corrects agent mid-run |
| Qodo Merge ticket compliance | No (uses linked ticket) | 4 labels: fully / partially / not compliant / verified | No | Partly (review comments) | Built on PR-Agent (check licence) | closest public feature |
| Review Assist | Yes (builds an "intent document") | No | No | Walkthrough, not ranked | MCP server + GitHub App | explains, does not judge |
| Spooled | No (tool-call graphs, never sees prompts) | Behavioural drift of agent runs | No | No | Yes | different problem |
| CodeRabbit, Greptile, Copilot review, Bugbot, Graphite | No | No | No | Line comments | Mostly closed | bug catch 6-82% on one vendor-run benchmark (Greptile's own) |
| Claude Code /code-review | Partial (session context) | No | No | Findings | Plugin | general review |
| agentfdr | Trajectory anomalies | Not diff-vs-intent | No | No | Yes | loops, token burn |

Gap confirmed: no public tool turns the agent session itself into intent, measures drift against the diff, flags risky unrequested changes, and ranks where to look.

---

## 8. Our design: open-source drift reviewer (working name TBD)

Goal: "Did the agent do what I asked, only what I asked, and where should I look first?" in under 30 seconds and under 5 cents, from the session that produced the change.

### 8.1 Inputs (local, read-only)
- Claude Code / Codex session transcript(s) for the branch (user messages, assistant messages, plan mode text, todo lists). Tool outputs stripped, as ARCTIC does.
- Repo context: CLAUDE.md / AGENTS.md, linked issue or PR body if present, commit messages.
- The diff (base..HEAD or working tree).
- Optional: test run log from the session; repo scope rules file.

### 8.2 Pipeline
1. Redact: secret scrubbing on transcript text.
2. Intent ledger (small model, zero-shot): list of intents with source message, timestamp, status (active / superseded / cancelled), explicit constraints ("don't touch auth"). Never sees the diff.
3. Fact extractor (deterministic, no model): structural diff facts (section 6 #2), AST-level where a parser exists (TS/JS, Python first), else line heuristics.
4. Backtranslator (small model, per file chunk): numbered "what this diff does" tasks. Never sees intents.
5. Matcher and judge (mid model, 3 shuffled runs): map tasks to intents; per intent satisfied / partial / unmet with evidence hunk; leftover tasks become candidate unrequested changes; classify each UC benign / risky using facts + scope rules first, model second. Disagreement across runs -> "uncertain".
6. Verification check (deterministic): tests ran after last edit? passed? test files or assertions changed?
7. Spotlight (cheap): always include hunks behind unmet/partial intents and risky UCs; then a generate + critic pass on the remaining diff limited to correctness, security, performance, with a hard cap of 3-5 regions.
8. Score: computed from items (weights per intent and per risky UC), mapped to ARCTIC's five buckets for comparability.

### 8.3 Outputs
- Terminal / markdown report: intent checklist with evidence, risky unrequested changes, verification status, top regions, score and bucket, confidence.
- JSON for machines (Vectorvane morning receipt, CI gates).
- GitHub PR comment / Action.
- Claude Code integration: Stop hook or slash command to run at turn end; optional pre-push gate.

### 8.4 Principles
Local-first, bring your own model key, works offline for the deterministic parts, every claim cites a transcript message or a diff hunk, abstains instead of guessing.

### 8.5 Language choice
TypeScript on Bun (matches the scanner and the mod; Sujal's core stack). Tree-sitter for multi-language AST facts.

---

## 9. Evaluation plan (beat ARCTIC's weak spots with public evidence)

Benchmark A, mutation-based drift injection (exact labels, unlimited size):
- Take a diff that matches its intents (e.g. reviewed agent sessions, or public PRs with clear issues).
- Inject known drift: drop one intent's implementation (DNF), add an out-of-scope edit in another module (risky UC), add a harmless null check (benign UC), delete an existing function (severe UC), weaken a test (integrity).
- Labels are known by construction. Measures per-intent accuracy, UC precision/recall, benign-vs-risky accuracy.

Benchmark B, real sessions: 50 of Sujal's own agent diffs, hand-labelled with ARCTIC's rubric (private). Compare our bucket accuracy and middle-bucket F1 with ARCTIC's 64.4% and 0.34.

Benchmark C, public agent PRs with linked issues (public agent-PR datasets exist; verify licence before use).

Metrics: per-intent verdict accuracy, UC detection precision/recall, risky-UC recall (the one that matters most), QWK and bucket accuracy for comparison with ARCTIC, judge agreement across runs, cost per diff, latency.
Success bar for v0.1: middle-bucket F1 above 0.5 (ARCTIC: 0.34-0.41), risky-UC recall at least 0.9 on Benchmark A, under $0.05 and 30 s per median diff.

---

## 10. How it plugs into Vectorvane

- Morning receipt per session: "did what you asked: 4 of 5 intents, 1 partial; 1 risky unrequested change (deleted export in billing.ts); tests ran and passed; look at these 3 hunks".
- Night mode: drift checked at each checkpoint; rising drift is a "night-garbage" signal and can pause the session or escalate a tier.
- Criticality: a risky UC or an unmet intent on a protected path makes the moment high tier.
- Charter: the project charter becomes a standing intent source (constraints like "client demo is booking flow first").

---

## 11. Build roadmap (proposal, not committed)

1. v0.0 (spike, 2-3 days): transcript -> intent ledger; diff -> facts; print both. Manually inspect 10 of Sujal's sessions.
2. v0.1 (1-2 weeks): backtranslation + matcher + judge with 3-run agreement; markdown report; mutation Benchmark A generator.
3. v0.2: verification check, risky-UC rules, Spotlight with critic, JSON output, Claude Code slash command / hook.
4. v0.3: GitHub Action, Codex transcript support, public benchmark results post.
Gate between each: numbers on Benchmark A and B.

---

## 12. Open questions

- Which small models give stable backtranslation (Haiku class vs open-weight local)? Measure on Benchmark A.
- How to segment a long multi-day session into the right intent set for one diff (git commit boundaries vs transcript time windows)?
- Licence of PR-Agent and of public agent-PR datasets.
- Name and repo under the vectorvane GitHub org.

---

## Sources
- ARCTIC paper (abs) https://arxiv.org/abs/2607.29516
- ARCTIC paper (html v1) https://arxiv.org/html/2607.29516v1
- ARCTIC on alphaXiv https://www.alphaxiv.org/abs/2607.29516
- RADAR: Automating Low-Risk Code Review at Meta https://arxiv.org/html/2605.30208v1
- Wink: Recovering from Misbehaviors in Coding Agents https://arxiv.org/pdf/2602.17037
- Wink pattern summary https://agentpatterns.ai/patterns/agent-design/wink-agent-misbehavior-correction/
- AI-Assisted Fixes to Code Review Comments at Scale https://arxiv.org/pdf/2507.13499
- From Technical Debt to Cognitive and Intent Debt (Storey 2026) https://www.alphaxiv.org/abs/2603.22106
- Bias in the Loop: Auditing LLM-as-a-Judge for SE https://arxiv.org/pdf/2604.16790
- Late requirements and code invalidation in coding-agent sessions https://www.emergentmind.com/papers/2609.03028
- Qodo Merge ticket compliance https://docs.qodo.ai/code-review/qodo-merge/integrations/ticketing-integrations
- Review Assist https://mcpservers.org/servers/uditk2/review-assist
- Spooled https://pypi.org/project/spooled-ai/0.9.0/
- Greptile AI code review benchmark (vendor-run) https://www.greptile.com/benchmarks
- agentsweep (secrets in agent history) https://radar.offseq.com/threat/every-ai-coding-agent-writes-the-secrets-you-paste-f3515e285a71bb29
