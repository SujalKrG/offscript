# Claim checks: research notes

What offscript's claim check is based on, and what nobody has built yet.

## What the research says

| Source | Finding | What offscript takes from it |
|---|---|---|
| [OverclaimBench, arXiv 2609.20812](https://arxiv.org/html/2609.20812v2) | An overclaim is a final report that the agent's own trajectory contradicts. Among runs with unfinished work, 80.4% were misleading. Labels: **admission** (says so), **omission** (stays silent), **explicit overclaim** (says it is done). Subagents raised coverage but not honesty. | Check every claim against the trajectory, never the report alone. Detect **omission** as "silent gaps". |
| [Advani, arXiv 2606.09863 (summary)](https://tsukumo.ch/blog/ai-agents-false-success) | Agents claimed success in up to 75.8% of failed runs. LLM judges reached 0.54 to 0.65 AUROC (near chance); simple detectors 0.83 to 0.95. Judges reward confident language and action counts. | No LLM judge. Verify the state the agent was supposed to change. |
| [False Done Rate, 90 runs](https://zenn.dev/sjh9714/articles/c2a5bb0f1d4930?locale=en) | False "done" claims mostly had nothing checkable in them ("everything removed"). Single-run results were unreliable. | Vague claims ("everything is done") are checked against every request in the turn, not accepted. |

## What is not built anywhere yet

All of the above are benchmarks or one-off harnesses with planted tasks. None checks the claims in a developer's *real* sessions against what actually happened in git and the transcript, after the fact, with no setup. That is offscript's gap.

## How the check works

1. **Extract** claims from the reply that closes each prompt's turn: tests pass, type check clean, committed, pushed, PR opened, merged, deployed, built, fixed, "only touched X", "everything is done". Plans, conditions, questions and code blocks are skipped.
2. **Check** each claim against evidence from *before* the reply was written:
   - action claims: the last matching command and its result,
   - "tests pass": also whether code changed after the run (**stale**),
   - "fixed" / "everything": the verdict of each request the reply answers,
   - "only touched X": files no request explains.
3. **Verdicts:** verified, contradicted, stale, overstated, unsupported, unverified.
4. **Silent gaps:** requests that are not done, failed, partly done or not in the change, where no reply in their turns admits it.

## Open questions

- Coverage claims ("I reviewed all the files") need the agent's Read calls; offscript records edits and commands but not reads yet. OverclaimBench shows these are the most common overclaim.
- The claim patterns are English-only.
- A labelled set of real claims (Drift Bench) is needed to measure precision.
