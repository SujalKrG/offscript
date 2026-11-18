# Module 6: Drift Bench (research and plan)

Status: research done 2026-11-18, nothing built. Claims marked "unverified" come from search summaries, not from the paper itself.

## Goal

Measure how often offscript is right, in numbers a stranger can trust, and stop regressions. The v0.0 gate only asked "were the intents correct" on 10 sessions. Since then we added scope, verdicts, claims, silent gaps and trace export. None of them has a measured accuracy.

## What the research says

### Papers that measure what we measure

- **OverclaimBench** (arXiv 2609.20812). Closest match to our claim check. Ground truth about coverage is computed from the transcript by deterministic rules; an LLM judge only classifies the final report, and it sees the delivered work plus the coverage data, never the transcript. Lessons we can use:
  - Validate the ground-truth registry with positive and negative controls: with all evidence present the case must be reported, with the evidence removed it must not, and every proper subset of required evidence must stay silent.
  - Re-judge a sample many times to measure the judge's own stability (91.1% of 774 runs unanimous over 8 judgments).
  - Report Wilson intervals; pin tool versions; withhold the corpus to avoid contamination.
  - Weaknesses to avoid: no human validation of the judge, one judge family, only 5 scenarios, scenarios tuned against one model, no seed control so runs cannot be reproduced.
- **Advani, False Success** (arXiv 2606.09863). Ground truth comes from programmatic state, not from the agent's words. LLM judges stayed at or under AUROC 0.65 on one corpus and 0.54 on another, and anchor on confident closing language. A cheap text detector reached 0.83 with a task-disjoint split. Their leakage controls are worth copying: split so no task appears in both train and test, mask the trigger tokens and check the score barely moves, test with the closing message removed. Human versus regex agreement on 200 items was 91.5% (kappa 0.86). Limits they state: adversarial rewording flipped 20 to 25% of predictions, and a flagged set at a 10% flag rate was only 50% precise.
- **How Coding Agents Fail Their Users** (arXiv 2605.29442, 20,574 real sessions). The best taxonomy of real failures and a template for annotation:
  - Symptoms with shares: developer constraint violation 38.3%, misread intent 27.0%, inaccurate self-reporting 22.6%, faulty implementation 17.8%, wrong diagnosis 11.6%, self-initiated overreach 10.2%.
  - Method: an LLM extracts candidate episodes, a second pass keeps evidence-grounded ones (it dropped 46.1% of candidates), two experts checked 200 records and found precision 0.93. Two researchers labelled 100 records with 0.83 percent agreement. They chose raw agreement over kappa because imbalance deflates kappa.
  - Per-axis accuracy varied a lot (symptom 0.84, cause 0.72, severity 0.64), so one headline number hides weak axes.
  - Threats they name: only failures that caused developer pushback are visible, early-adopter selection, 94.9% Claude-family sessions in one source.
  - Release: episodes only from permissively licensed repos, raw traces not redistributed.
- **Message-code inconsistency in agent PRs** (arXiv 2601.04886, 974 annotated PRs, from the search summary): the second most common mismatch (22%) is a description that leaves out significant changes. This is our "undisclosed" check.

### How to build the benchmark so it is valid

- **Agentic Benchmark Checklist** (Zhu et al., NeurIPS 2025, arXiv 2507.02825). Applied to 10 benchmarks it found outcome-validity flaws in 7 and task-validity flaws in 7, with overestimates of up to 100% in relative terms. Items we adopt:
  - Verify the ground truth is correct (T.7), have an oracle solver that shows the tasks are configured right (T.9), inspect outliers (T.10).
  - Check relevant and irrelevant state, to catch out-of-scope changes (O.g.2). That is exactly our scope check.
  - Report trivial-agent baselines (R.13), significance (R.10), the quantitative impact of known flaws (R.9), contamination measures (R.3), and an update plan (R.4).
- **Synthetic cases are easier than real ones** (Evaluating Synthetic Bugs, arXiv 2208.11088): injected bugs let tools "optimize for the benchmark". FixReverter-style realism (derive injections from patterns of real failures) is the mitigation. So: never merge synthetic and real results into one headline number.
- **Statistics for small sets** (Bowyer et al., arXiv 2503.01747, from the search summary, PDF not readable here): do not use normal-approximation error bars below a few hundred items; use Wilson, Clopper-Pearson or a Bayesian interval, and paired comparisons between systems on the same items. Example: 5 of 5 correct gives Wilson roughly 57% to 100%, not 100% to 100%.
- **Agreement metrics under imbalance**: kappa and Krippendorff's alpha are deflated when one label dominates; report raw agreement, kappa and Gwet's AC1 together (BMC Med Res Methodol 2014, from search). Practitioner rule: kappa below 0.4 means the labelling rules are ambiguous, rewrite them before adding labellers.
- **Contamination and leakage**: canary strings catch verbatim leaks only; the strong measures are a private held-out set and publishing the public and private split scores side by side. For a rule-based tool the contamination that matters is tuning on the test set.

## What we have today

- 10 filled label blocks in `spike-results/<repo>/` (local, untracked): one block per session (intents correct yes/no, missed and invented counts, provenance right yes/no, flags useful yes/no). No per-item labels for verdicts, claims, scope flags or silent gaps.
- `spike:score` gate: intents correct for 6 of 10 sessions and traced coverage 0.8 or more. It does not compute precision or recall, and the research bars in `research/design-spec.md` (risky-change recall 0.9, middle-bucket F1 above 0.5) are not implemented.
- A seeded generator exists (`packages/core/test/trace-world.ts`, `trace-model.test.ts`: `World`, `SessionBuilder`, mulberry32, unique line texts, expected result computed without the exporter). It lives inside test files and covers attribution only, not scope, verdicts or claims.
- **Important:** the scope, verdict and claim rules were tuned over five rounds on the 10 October sessions. Scoring on those sessions is training on the test set. The November sessions were only exported structurally, never used to tune.

## Design

**Three separate result sets, never averaged together.**

1. **Synthetic (public, exact labels).** A seeded generator builds a repo and a transcript for each case, with one injected behaviour and its exact expected output, plus a matched clean control for every injection (the OverclaimBench positive and negative control idea). Mutation catalogue mapped to checks and to the 2605.29442 symptom codes:
   - constraint violation (S3): "don't touch X", then X is edited.
   - overreach and undisclosed change (S4): an unrelated file changes and the reply never mentions it.
   - false claims (S7): "tests pass" with no run, tests run before later edits (stale), "merged" with no merge command, "everything done" with a request not done.
   - silent gap: an unfinished request that the reply never mentions, plus the admitted version.
   - distractors that must not trigger: advice sentences, tables, history ("committed in abc123"), harness messages.
   - attribution: the cases already in the export model test.
   Injection templates are derived from the real failures seen in the October and November sessions, so they are not invented. Each case is a seed plus a generator version, so nothing bulky is stored. A fixed set of seeds runs in CI on every PR.
2. **Real labelled (private).** Real sessions with per-item labels (verdict right, claim verdict right, flag right, silent gap right). Split by session into a dev set (the 10 October sessions, already tuned on, used only for development) and a **held-out set of sessions the rules never saw** (the November sessions and anything new). Rules are frozen, and thresholds written down, before the first held-out run. Labels are made **blind**: the labeller sees the transcript evidence for an item, not offscript's output, because humans anchor on tool output the way LLM judges anchor on closing language. Sampling: label every item offscript flagged as a problem, plus a random sample of the items it passed (otherwise recall is unmeasurable).
3. **Trivial baselines (R.13).** Always say fine, always flag, random flags at the same rate, trust the agent's own summary, and claim detection from reply text alone with no evidence. A check only counts if it beats these. An LLM judge baseline is optional and costs money; the literature suggests it will not beat evidence-based checks.

**Metrics.**
- Per check: precision, recall and F1 of the problems it reports, each with a Wilson 95% interval; cluster bootstrap over sessions for the real set, because items inside one session are not independent.
- **Abstention is reported separately.** "Needs judgment" and "not checked" are decisions not to decide, so report coverage (share decided) and accuracy on the decided items, not one blended number.
- **False-assurance rate**: how often offscript says done, verified or kept and a human says it was not. This is the worst error for this product and gets its own line with an upper bound.
- Confusion matrices for the multi-class verdicts; per-axis numbers, never one headline.
- Regression gate in CI: paired comparison against the last release on the same cases; no check's false-assurance rate may rise.
- Agreement: raw agreement, kappa and AC1 together, with the single-annotator limit stated (below).

**Proposed bars (to be confirmed before the first held-out run, then not changed):** synthetic exact-label cases pass 100% except limits listed in the report; real held-out false-assurance rate point estimate at or below 5% with its interval shown; recall of real problems (violated, contradicted, silent gap, undisclosed) at or above 0.8; precision of reported problems at or above 0.7. These are proposals; the data may force a rethink and that is fine as long as it is written down before looking.

## Risks and limits to state up front

- One labeller, who is also the tool's author. No inter-annotator agreement is possible. Mitigation: re-label a random 20% two or more weeks later (intra-rater agreement), invite one or two contributors to label a redacted subset, and call the labels "single annotator" in the results.
- One developer, one repo, mostly one agent family. Results do not generalise beyond that and must say so.
- Real sessions come from a client project. They cannot be published. Publish only aggregate numbers and the synthetic set (with a canary string); keep real labels private and offer controlled access.
- Synthetic cases overstate accuracy (see Evaluating Synthetic Bugs). That is why they are a separate line.
- Held-out size will be small (tens of sessions, hundreds of items). Intervals will be wide. Publish them anyway.
- Single-annotator labels can still be wrong; read every disagreement between label and tool (outlier inspection) before scoring.

## Build steps

1. Move the seeded generator into a reusable `bench/` module, covering sessions, repos and expected outputs for all checks; keep the export model test running on it.
2. Mutation catalogue with matched controls; fixed CI seeds; failure output prints the seed and operation log.
3. Label sheet exporter (blind, stratified sample) and importer; split rule recorded in a manifest; labels kept out of git.
4. Scorer: per-check metrics with Wilson and cluster bootstrap, abstention coverage, false-assurance rate, baselines, confusion matrices, version-to-version paired comparison.
5. `bun run bench` (synthetic, in CI) and `bun run bench:real` (local, uses the private labels); results written to `bench/results/<version>.md`.
6. Docs: README section with numbers and limits, CHANGELOG, this note's decisions; update the v0.1 gate text.
7. Review pass, then run on the held-out set once, publish whatever it says.

## Sources

- OverclaimBench: https://arxiv.org/html/2609.20812v3
- Advani, False Success: https://arxiv.org/html/2606.09863
- How Coding Agents Fail Their Users: https://arxiv.org/html/2605.29442v1
- Message-code inconsistency in agent PRs: https://arxiv.org/html/2601.04886v2
- Agentic Benchmark Checklist: https://arxiv.org/html/2507.02825v5
- Evaluating Synthetic Bugs: https://arxiv.org/pdf/2208.11088
- Don't use the CLT in LLM evals with few datapoints: https://arxiv.org/pdf/2503.01747 (read only through search summaries)
- Agreement under imbalance: https://bmcmedresmethodol.biomedcentral.com/articles/10.1186/1471-2288-14-100

## As built, phase A

Built: build steps 1 (partly), 2, 4 and 5 for the synthetic set only. Deviations from the plan above:

- The generator was not moved out of the test files. `packages/bench` reuses `World` and `SessionBuilder` from `packages/core/test/trace-world.ts`, which gained `say` and `run`; the export model test is untouched.
- Cases use the offline heuristic ledger (one request per prompt). The synthetic set therefore does not measure the intent ledger, and prompts are written to give exactly the intended requests.
- With that ledger a reply is judged against one request, so "everything is done" is `contradicted` when the request of that turn has no work and `overstated` when it is partly done (code but no commit). The "one request has no work among several" case is encoded as two prompts, the second without work.
- Finding level scoring: a finding is check + subject (claim kind, file path, request id). No flag and no silent gap counts as the product saying "ok" for the false-assurance rate; a missing claim does not. Abstentions ("unverified", "needs judgment", "not checked") are excluded from TP/FP/FN/TN and fail the case. A clean control that expects "verified" and gets no claim counts as `miss` and fails the case.
- Baselines are computed from each case's expected structure. "always-flag" is generous: it reports the right problem type on every expected problem.
- Not built: label sheet exporter and importer, real labelled set, `bench:real`, cluster bootstrap use (the function exists and is tested, nothing calls it yet), version-to-version paired comparison, confusion matrices, attribution cases (still covered by the export model test), and the README numbers.
- Cases are re-created per seed (a git repo each), about 0.6 s per case on this machine; `bun run bench` defaults to 20 seeds.

## Review and adversarial results

Run 2026-11-18, version as in `packages/bench/package.json`, Windows, `bun run bench` (20 synthetic seeds, 3 adversarial seeds, 11m23s). Single author, single machine. The product code was not changed by this work.

### What was reviewed and fixed

`packages/bench` is untracked, so there is no git diff to read; this list comes from reading the code against "As built, phase A" above, plus the diff of `packages/core/test/trace-world.ts`. Real fixes visible:

- Coverage counted a wrong-type problem twice (once as a miss, once as a false alarm); it now counts each expected decision once (test "coverage counts each expected decision once").
- A check with no problems printed an upper bound of 100% for false assurance; it now prints `n/a` and `null` in the JSON, never NaN (test "no NaN or undefined number").
- The baseline "always-flag" now names one fixed problem per check, so a wrong type is both a miss and a false alarm; an "oracle type" row keeps the generous variant.
- A duplicated random generator was removed (one `mulberry32` in `metrics.ts`), and two distractor lines that a reader would take as test claims were removed from the catalogue.
- The test `World` (shared with the export tests) retries a git process that never ran (no exit status) and now reports status, signal and spawn error when git fails; its temp directories are removed with retries on Windows. A real git failure is still not retried.
- This pass: the "20 seeds really vary the world" test had no timeout and hit Bun's 5 s default (it builds many git repos); it now has 60 s. Three runs of `bun test packages/bench`: 15 pass, 0 fail each, 47.4 s, 52.5 s, 45.3 s. No `.lock` files were left in `.git`.
- Adversarial case `pr-unsupported/4` ("Created PR #42.") failed on every seed and was missing from the known list, so the full bench exited 1; it is now listed as a confirmed miss.

### Review of the known-miss expectations

For each of the 21 entries in `KNOWN_LIMITS_ADVERSARIAL` I judged the expectation from the case text alone. All 21 are reasonable for a careful reader, so none was changed to `debatable`. The closest calls, kept as confirmed misses: `fake-output` (a pasted test summary with no run behind it), `history-tests` (a past-tense remark about Friday's build) and `pr-unsupported/1` ("PR is up."). The debatable set (`bare-all-green`, `ci-passes`, `done-and-dusted`, `shipped/bare`, `disclosed/module-name`) was already marked and is reported separately.

### Adversarial set (blind to the rules)

126 distinct cases, seeds 1 to 3, 378 runs (363 headline, 15 debatable). Written from the failure taxonomy and from how agents phrase things, without reading the claim, scope or verdict rules. Expectations are what a careful human reader would say.

| measure | value |
|---|---|
| TP/FP/FN/TN | 165/27/33/120 |
| precision | 86% [80%-90%] |
| recall | 83% [78%-88%] |
| false assurance | 9/198 (<=8%) |
| unreported claims | 24 |
| abstentions | 0 |
| runs passed | 300/363 |
| failures outside known limits | 0 |
| known misses | 63 runs, 21 distinct cases |
| debatable cases that differ | 9 runs (3 cases) |

Blind accuracy per check (share of runs of that check with no disagreement, Wilson 95%):

| check | correct | accuracy |
|---|---|---|
| claim | 228/276 | 83% [78%-87%] |
| flag | 63/78 | 81% [71%-88%] |
| gap | 39/42 | 93% [81%-98%] |
| verdict | 6/9 | 67% [35%-88%] |

The three seeds only change names and filler lines, not the phrasing, so 378 runs are 126 phrasings, not 378 independent samples. The intervals are narrower than the real uncertainty.

For comparison the synthetic set (which the rules were written around) scores 400/400 with 100% recall and precision (Wilson lower bound 98%). Do not read the two as one number: the gap between them is the point.

### Confirmed product misses (known limits, by check)

Historical: this is the list as found by the first run. All of it is fixed, see "Product fixes from the adversarial set" below.

Claim extraction:
- tests: a results table row "unit tests | passed" and pasted test output in a code block are not extracted; "make test" is not recognised as a test run, so a true claim is called unsupported.
- pr: "PR is up." and "Created PR #42." are not extracted (the verified controls therefore get no verification).
- build: "The build succeeds." and "Build passes." are not extracted, with or without a real build.
- everything: "That's everything, nothing left to do." is not extracted (also hides the silent gap on the second request, check gap).
- only-touched: "Just X, nothing else was changed." is not extracted (the undisclosed flag is still right).
- fixed: "Not done: ... is still open" is read as a "fixed" claim and called contradicted.
- distractors read as claims: "Last week's release was deployed by Dana" (deploy), a quoted README line "all tests pass" that the reply calls unverified (tests), "The suite was green on Friday's build, before my change" (tests).

Flag (constraints):
- "Please leave X alone" and "X is off limits" are not read as constraints, so the edit is not flagged.
- "without changing X" also flags the file the user asked to edit, with and without a violation (false alarm on the requested file).
- A constraint the user lifts in a later prompt is still enforced: false alarm on the flag and a violated verdict (counts under flag and verdict).

Gap: only the "That's everything" case above.

Verdict: only the lifted-constraint case above.

### Product fixes from the adversarial set

The adversarial set found 21 misses. I then fixed the product, with general rules and families of tests in `packages/core/test/claims.test.ts` (at least four phrasings that must trigger and near misses that must not, per rule). The bench expectations were not edited; the 21 entries were deleted from `KNOWN_LIMITS_ADVERSARIAL` because the cases pass. Final full run: synthetic 400/400, adversarial 363/363 headline runs, 0 known misses (9 debatable runs still differ, same 3 cases as before: `bare-all-green`, `ci-passes`, `done-and-dusted`).

| group | root cause | fix |
|---|---|---|
| A, PR | the history filter dropped any sentence with a PR number, and "PR is up" had no pattern | the number of a PR the agent "opened/created/raised/filed" is ignored by the history check; the pr pattern also takes "PR (#n) is up/open/created" |
| A, build | the pattern only knew "build succeeded/passed"; "Build passes." was also dropped as an imperative ("build ...") | present tense forms added (not when "passes" is followed by an object such as "the flag"); an action word followed by passes, succeeds, works or is is not an imperative |
| A, everything and only-touched | the not-a-claim word "nothing" and the phrase "to do" swallowed "nothing left to do"; "left to" in the gap words read it as an admission; "nothing else was changed" had no pattern | "nothing left to do" exempted in all three places; only-touched also matches "nothing else was touched/changed/modified/edited" |
| B | `make test` was not in the test command list | `make test`, `make tests`, `make check` (make must start the command, not sit in a path) added to `TEST_COMMAND_RE` |
| C | table rows and code blocks were skipped | a row whose second cell is only a pass word becomes a sentence; a code block with a "N passed" summary line and no nonzero failure on it yields a tests claim |
| D | "leave X alone" had a gap that stopped at the dot in a file name; "off limits", "read-only", "frozen", "hands off" were unknown; a lifted constraint was never lifted | gap allows dots inside names; the new phrases added; a later prompt ("you can edit X now", "go ahead and change X") that shares a word with the protected target ends the constraint, so edits in turns from that prompt on are not flagged and the verdict is "kept" |
| E | the words of the whole sentence were the protected target, so the requested file matched | only the words after "don't touch", "without changing", "hands off" (inside "leave ... alone", before "is off limits") are protected; the rest of the sentence counts as request words |
| F | no notion of time or reported speech | time markers (last week/month, yesterday, weekdays, "N days ago"), "was deployed/merged by <someone else>", reported speech ("README/docs/changelog/ticket says", "according to") and blockquote lines are skipped. "I ran the tests earlier and they passed" and "The output says 42 passed" are still claims |
| G | "Not done" matched the done word of the fixed pattern | "not done/working/complete/finished" and "still open/broken/failing/missing" are not-a-claim words |

What real sessions showed. Only 2 of the 10 named October sessions exist on this machine (da8cbd7d and e34d1222 of the private test repo); the other 8 ids are not in `~/.claude/projects`. I also ran the three other October sessions of that repo (98573b47, ce1a24fc, cae2e2ec, one prompt and no edits each). The official `--no-llm` spike report is identical before and after for all five (no ledger, so no claims or verdicts there). Because `--no-llm` produces no claims, I also ran the heuristic ledger through the same pipeline on the same sessions and diffed claims, verdicts, flags and silent gaps. Verdict counts, flags (0 undisclosed, 0 against-instruction) and silent gaps (10 and 1) did not change. Claims: da8cbd7d 250 to 253 (9 new, 6 gone), e34d1222 47 to 48 (2 new, 1 gone). New: 4 PR claims in da8cbd7d and 2 in e34d1222 ("I opened PR #236...", "The PR is open at .../pull/257"), all verified against a `gh pr create` that ran: true positives. 5 only-touched claims in da8cbd7d ("Nothing else was changed", "nothing else was touched"), all verified; 3 of them are about a terraform apply or an IAM role, not about files, so they are noise, harmless here but they could be marked contradicted in another session. Gone: 7 "fixed" claims that were noise ("Not done**", "That's not done.", "Still not done**", a sentence about drivers who "has not done the daily verification", a tally line "10 are fixed ... 8 are still open"): false alarms removed. No new flag, no new silent gap, no changed verdict. The table and code block rules produced no change on these sessions (no noise, and no evidence they help on real text). This is two sessions, not a labelled set.

Still in `KNOWN_LIMITS_ADVERSARIAL`: nothing. Known weaknesses that remain: "nothing else was changed" about something other than files is read as an only-touched claim; a lift needs a word shared with the protected target, so "you can touch it now" does not lift; pasted output is read only for pytest, jest, cargo and "N passed" style summaries.

The adversarial set is now a development set, no longer blind: the rules above were written against its cases, and the families of tests only reduce, not remove, the overfitting risk. A fresh blind batch, written by someone who has not seen these rules, is needed before quoting a blind accuracy. The 100% above is not one.

### Not measured

- Intent extraction (the ledger). Both sets use the offline heuristic ledger with prompts written to suit it.
- Real sessions of any kind: no labelled real set exists, so there is no real-world accuracy, precision or recall number, and none should be quoted from this file.
- Held-out generalisation: the adversarial set is blind to the rules but not to me; I wrote the cases and the expectations once, and a misread expectation would show up as a product miss. No second labeller.
- Attribution (covered only by the export model test), confusion matrices, version-to-version paired comparison.
- Independence: seeds vary names, not phrasing, as noted above.
- Phrasing the author did not think of. The 21 misses were found by about 126 phrasings; there is no reason to think that is all of them.

### Unfinished (Phase B)

- Label sheet exporter and importer (blind, stratified), real labelled set, dev and held-out split, manifest, `bench:real`.
- Cluster bootstrap over sessions on real data (function exists and is tested, nothing calls it).
- Confusion matrices for the multi-class verdicts.
- Paired comparison against the last release, and the CI regression gate on false assurance.
- A second labeller or an intra-rater relabel of a sample, and kappa and AC1 on it.
- Bars (recall 0.8, precision 0.7, false assurance 5%) still need to be confirmed before any held-out run.
- Deciding which known misses to fix in the product; this work only lists them.
