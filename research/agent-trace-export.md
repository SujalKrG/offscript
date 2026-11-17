# Module 5: Agent Trace export (research and plan)

Status: research done 2026-11-17, nothing built yet. Sources are listed at the end. Where a claim comes from a search summary and not from the primary document, it is marked "unverified".

## What we want

`offscript export` turns what offscript already knows (which agent turn wrote which line, in which commit) into the open Agent Trace format, so other tools (blame views, dashboards, review tools) can read it. It must follow the project rules: evidence first, never invent attribution, never modify the user's repo unless asked.

## What the research found

### 1. Agent Trace v0.1.0 (RFC, January 2026)

The format: one record per revision. A record holds `version`, `id`, `timestamp`, optional `vcs` and `tool`, and `files`. Each file has `conversations`, each conversation has `ranges` (1-indexed start and end line) and a `contributor` of type `human`, `ai`, `mixed` or `unknown`, with an optional `model_id` written `provider/model`. Line numbers refer to the recorded revision, not to today's file. To find who wrote line N you run blame, take the revision, then look up the trace for that revision.

**The prose spec and the published JSON schema disagree.** I downloaded `https://agent-trace.dev/schemas/v1/trace-record.json` and checked it object by object:

| Point | Prose spec | Published schema |
|---|---|---|
| `tool.name`, `tool.version` | optional | both required (when `tool` is present) |
| Extra fields | "does not say" | `additionalProperties: false` on every object except `metadata` |
| `version` | example `"0.1.0"` | pattern `^[0-9]+\.[0-9]+$`, so `"0.1.0"` is rejected and `"0.1"` passes |

Consequences: vendor data must go inside `metadata`, and a record only validates if we follow the schema, not the prose.

**Left undefined by the spec:** where records are stored, the `content_hash` algorithm and normalisation (only a `murmur3:` prefix is shown), how rebases and merges are handled, when to use `mixed` versus a per-range override, and how code written by scripts is attributed.

**Project health is unclear.** The site still lists `github.com/cursor/agent-trace`, but that address returns 404 today (checked with `gh` and `curl`). A Wayback snapshot dated 2026-07-25 exists, but I could not read it, so I do not know whether the spec changed after January. Supporters named on the site: Cloudflare, Vercel, Cognition, Amp, OpenCode, Cline, Google Jules, git-ai.

### 2. Git AI Standard v3.0.0 (the most mature neighbour)

Open source, Apache-2.0, about 3,000 stars, pushed to daily. Stores one note per commit under `refs/notes/ai`: an attestation section (file, then `session_key line-ranges`) and a JSON metadata section. Session ids are deterministic: `s_` plus the first 14 hex of `SHA256("<tool>:<conversation_id>")`. A search result headline says Git AI is now part of OpenAI (unverified, matters only for long-term governance).

Four invariants from its rewrite spec are the best design rules I found. We adopt them as written:

- **I1 Evidence:** attribute a line only on recorded evidence, never on similarity or "probably the same line".
- **I2 Conservation:** if git's own diff shows a line survived unchanged, its attribution survives with it.
- **I3 Immutability:** decide only from immutable inputs (commit, tree, blob), never from the live worktree after the fact.
- **I4 Fail closed:** when facts are missing, write no attribution. A gap is acceptable, a wrong attribution is not.

It also separates "known human" from "untracked" (no data). That maps to Agent Trace `human` versus `unknown`/omitted: absence of AI evidence is not proof of a human author.

Its fuzzer spec is the best testing method found: an expected-attribution model that never reads the tool's output, one unique character per line so survival is unambiguous, one seeded random generator, the seed and full operation log printed on failure, and every failure turned into a minimal deterministic regression test. Fixed seeds run in normal CI, long runs nightly.

Storage has no common convention: Git AI uses `refs/notes/ai`, others use `refs/notes/exceeds-ink` and `refs/notes/agentnote`. Git AI reports note contention on repos landing about 1,000 commits an hour.

### 3. Papers (from abstracts and search excerpts; verify before citing)

- **Between the Commits** (arXiv 2609.29744): traces code blocks to commit and trigger. Method point worth copying: a block that cannot be located is reported as unresolved, not guessed; relocating by text first and then by enclosing function cut unresolved from 11.4% to 0.4%. It also found 14.3% of code-generation events had an error that was fixed before any commit, invisible in git, which is the reason to read the transcript and not only git.
- **AgenTag** (2608.00966) and **Fingerprinting AI Coding Agents** (2601.17406): attribution from commit and PR text. They report 5.0% of PRs labelled human show explicit AI evidence. So "no AI evidence" must not be exported as `human`. These methods infer after the fact; we have the transcript, which is stronger evidence, so we do not need inference.
- **OverclaimBench** (2609.20812): already shaped module 3. For module 6 it is the model for labelling unfinished runs as admission, omission or explicit overclaim.

### 4. What offscript has today (code survey)

This changes the size of the module. It is not just an exporter.

| Need | Today |
|---|---|
| Per-line credit | None. Provenance stores per-file counts and prompt turns. Lines are matched by trimmed text, so `}` and `return null;` are ambiguous |
| Line numbers | Provenance drops them. Committed lines use each commit's own post-image, uncommitted lines the working tree |
| Per-commit view | `sessionChange` nets all commits into one diff and keeps only the SHA list |
| Model id | Not captured. Assistant messages carry `message.model` but ingest ignores it |
| Session id, cwd, Claude Code version | Captured |
| Writes to `.git` | None. Only read-only git commands, always `--no-optional-locks` |
| CLI | `main.ts` dispatches on `[cmd, sub]`, so an `export` command fits. `list --json` hardcodes `schemaVersion: 1` instead of using the constant |

## Design decisions (my recommendations)

1. **One record per commit** in the session's change, with `vcs.revision` set to that commit. Uncommitted edits have no revision, so they are not exported; the command says how many lines were skipped and why. Never invent a revision.
2. **Evidence rule (I1, I4).** A range is `ai` only when a transcript edit, a backup delta or a recorded shell write explains it. Lines with no evidence are left out of the record, not labelled `human`. Lines another session wrote are credited to that session's conversation. `human` is not emitted in v1, because we have no per-line evidence of a human author.
3. **Match by run, not by single line.** Credit an added hunk to an edit when the edit's added lines contain the hunk as a contiguous sequence. A lone `}` that matches many places is never credited on its own. Lines that cannot be placed are counted as unresolved and reported (as in Between the Commits), never guessed.
4. **Contributor.** `ai`, with `model_id` as `anthropic/<message.model>` when known, else omitted.
5. **`tool`.** `{ name: "claude-code", version: <cliVersion> }`, because consumers show which agent wrote the code (as in the spec example). The schema requires both fields, so we only emit `tool` when we know the version. The fact that offscript reconstructed the trace goes in `metadata`: generator name and version, and `derivation: "transcript"` so nobody mistakes it for live capture.
6. **Conversation link.** No `url`: a local transcript has no URL, and a file path leaks the user's folder names. Put the opaque session id in `metadata` under a reverse-domain key (proposal: `io.github.sujalkrg.offscript`). No prompt text, no paths outside the repo.
7. **`version`.** Emit what the published schema accepts (`"0.1"`) as one constant, and document the mismatch. Our tests validate against the vendored schema, so the choice is machine-checked. Revisit if upstream fixes the schema.
8. **`content_hash`.** Omit. The algorithm and normalisation are undefined, so any value would be a guess.
9. **Output.** Default: JSON to stdout. `--out <dir>` writes `<dir>/<sha>.json`, MIME type `application/vnd.agent-trace.record+json`. Nothing is written to `.git`. Git notes are deferred: opt-in later, under our own ref (never `refs/notes/ai` or `refs/notes/commits`), because writing refs breaks the "offscript never modifies your repo" promise and has contention costs.
10. **Rewrites (rebase, squash, cherry-pick).** The spec leaves this open. We regenerate from the session each time and key each record to the commit as it exists now (our patch-id dedupe already collapses cherry-picked copies). A record for a commit that was later rewritten is stale by definition; I3 says rebuild from immutable inputs, not patch old output.
11. **Validation without a new dependency.** Vendor the published schema file, record its SHA-256, and check records with a small in-repo validator covering only the keywords the schema uses (type, required, additionalProperties, enum, pattern, minimum, maxLength, and the `uuid`, `date-time` and `uri` formats). Every test that emits a record validates it.
12. **Testing, borrowed from Git AI's fuzzer.** A seeded generator makes small sessions and repos (edit, rewrite a line, amend, rename, squash) with one unique line per edit, computes the expected attribution itself, then compares it with the export. It prints the seed and the operation list on failure, runs fixed seeds in CI, and each failure becomes a minimal regression test. Plus a round-trip check: for every exported range, `git show <sha>:<path>` must contain those lines at those numbers.

## Build steps

1. Ingest: read `message.model` per assistant message and keep it on edits.
2. `git.ts`: return per-commit added lines with their new line numbers (the data `showCommits` already has before it is merged).
3. Provenance: split the matching into a function that returns per-line credit by run, and have `traceProvenance` use it, so there is one matcher and not two.
4. `trace.ts`: build one record per commit, the vendored schema and the validator.
5. CLI: `offscript export [session] [--out dir]`, plus the `list --json` constant fix.
6. Tests: fixture cases, the seeded generator, the round-trip check.
7. Docs: README (feature and the interpretation notes), CHANGELOG, this note's decisions.
8. Review pass (Sonnet), then real-data run on the ten `C:\ocar` sessions, checking the unresolved rate.

## Risks

- **The spec may move or already have moved.** Pin to the vendored schema and re-check upstream before release.
- **Line-text matching is lossy.** Run-based matching and "unresolved" reporting keep it honest; the unresolved rate on real sessions is the number to watch.
- **Interpretation choices** (items 5, 6 and 7) are ours, not the spec's. They are documented in the README so a consumer is not surprised.

## Module 6 notes (benchmark, for later)

- Agreement between labellers: aim for Cohen's kappa of 0.7 or higher; below 0.4 the label rules are ambiguous and should be rewritten, not given more labellers (practitioner guidance, not a standard).
- Cases generated by a model can carry contamination from whatever the model has seen. Prefer deterministic generators and real labelled sessions; keep a held-out split.
- Treat the Git AI fuzzer approach as the template for the synthetic part: seeded, replayable, independent expected result.
- The search found no mutation-specific benchmark guidance; this part is our own design.

## Sources

- Agent Trace spec and schema: https://agent-trace.dev/ and https://agent-trace.dev/schemas/v1/trace-record.json
- Git AI Standard v3.0.0, rewrite-ops spec, attribution fuzzer spec: https://github.com/git-ai-project/git-ai (`specs/` and `docs/`)
- Cognition on Agent Trace: https://cognition.com/blog/agent-trace
- Between the Commits: https://arxiv.org/pdf/2609.29744
- AgenTag: https://arxiv.org/html/2608.00966v1 and Fingerprinting AI Coding Agents: https://arxiv.org/abs/2601.17406
- OverclaimBench: https://arxiv.org/pdf/2609.20812
- Notes storage by other tools: https://usegitai.com/docs/how-git-ai-works

## As built (2026-11-18)

Build steps 1 to 7 are done. Step 8 (a Sonnet review pass and a run on the ten `C:\ocar` sessions) has not been done, so the unresolved rate on real sessions is not measured yet. Deviations from the plan:

- **No per-conversation field for the session id.** The published schema allows `metadata` only on the record, not on a conversation. Our metadata holds `session_id` (the exported session) and `conversation_sessions`, a map from file path to the session id of each conversation, in the same order as `files[].conversations`.
- **Matching order.** The matcher takes the longest run per tier, in this order: this session's edit-tool calls, then its file-backup deltas, then other sessions. It does not take the longest run across all tiers, because a backup delta of a whole file would otherwise outrank the exact edit that wrote it. The old rule "a backup-only line that another session wrote with an edit tool belongs to that session" is kept.
- **"Trivial" line.** A line with fewer than 8 letters and digits (`}`, `});`, `return;`, `end`) cannot be credited on its own. A run is credited when it holds at least one non-trivial line.
- **Blank lines.** Blank lines never decide a match. A blank line between two lines credited to the same edit is credited with them, so ranges stay in one piece. Blank lines at the edge of a run are not credited.
- **Renames.** Edits made under a file's old name still count. The old name is taken from rename entries in the session's commits.
- **Duplicates by patch-id.** The existing rule keeps the first (oldest) commit of each distinct patch among the commits reachable from any branch. Commits that are no longer reachable (before an amend or rebase) are not in the log and are not exported.
- **Record `timestamp`.** It is the time of export, not the commit time. The id is a random UUID, so two exports of the same commit differ in `id` and `timestamp`.
- **`review` is affected too.** `traceProvenance` now calls the same matcher. Numbers on the existing tests did not change, but a lone trivial line that used to be credited by text is now untraced, so traced percentages on real sessions can drop slightly.
- **`OtherSessionIndex`** is now a map from file to the other sessions' edits (it was a map of line text to session id).

### Review pass (2026-11-18)

Changes made after an independent review of the build:

- **Each edit line explains one diff line, once.** A line an edit wrote once is no longer credited to a second copy of the same text in the same file, or to a later commit that adds the same text again (the oldest commit gets it). A blank line between two credited lines is credited only if that edit wrote a blank line there.
- **Rename names are per commit.** A rename in a later commit no longer lends the old file's edits to an earlier commit that used the new name for another file.
- **Work budget.** Thousands of repeated trivial lines made the matcher cubic (3,000 lines took 50 s). Runs with no non-trivial line left are skipped at once, and a per-file step budget leaves the rest unresolved instead of hanging.
- **Diff parsing.** A removed line starting with `-- ` (SQL, Lua) was read as a file header, and a path with a space kept git's trailing tab, which dropped the file from the session's change.
- **Validator.** Fields named like `Object.prototype` members (`constructor`, `toString`, `__proto__`) were accepted as known; dates such as Feb 30 and hour 24 were accepted; `uri` accepted characters RFC 3986 forbids; `maxLength` counted UTF-16 units. A model name over 250 characters is now left out instead of failing the export.
- **`--out`.** The `.git` check now also catches `.git.`, 8.3 names, symlinks and junctions, and worktree git directories. A failed write removes its temporary file.
