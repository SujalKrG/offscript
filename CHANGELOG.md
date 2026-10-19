# Changelog

All notable changes to offscript are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Claim check (report section 2a): claims in the agent's replies (tests pass, type check clean, committed, pushed, PR opened, merged, deployed, built, fixed, "only touched X", "everything is done") are checked against evidence from before the reply: verified, contradicted, stale (tests passed, then more edits), overstated, unsupported or unverified. **Silent gaps** list requests left unfinished that the agent never mentioned. Deterministic, following OverclaimBench and Advani 2026; notes in `research/claim-checks.md`.
- Verdict per request (report section 1b): done, partly done, failed, not done, not in change, answered, or needs judgment for tasks; kept or violated for constraints. Decided from independent evidence in that request's turns (code that landed, commit/push/PR/merge/test/type-check/build/deploy commands and whether they succeeded, substantive replies), never from the agent's own summary. Files no request explains are listed as extra work. Commands you ran yourself with Claude Code's `!` shell count as evidence (marked "you ran") and are no longer treated as prompts. When a test or deploy request shows no recognised run, the verdict lists the commands that did run.
- Verdicts never say "done" without proof: a "fix X and commit" whose code is not in the change is "partly done"; a command with no recorded result is "needs judgment"; the last attempt decides, and earlier failures are noted. Constraints that cannot be checked from files are "not checked" instead of "kept". An answer must close the request's turns, not be progress narration. Actions are read only from clauses that start with an action verb, so "push notifications" or "commit message parser" are not git requests, and commands that merely mention a word (`cat deploy.yml`, `git merge-base`) do not count. Your own `!` command output is read from stdout and stderr and attached only to the command right before it.
- Scope check per changed file: anchor (what you asked for), related (its test, an import either way, a sibling in a small folder, or something the agent told you about), derived (lockfiles, generated and housekeeping files) or drift. Only drift is flagged `undisclosed`, which removes the noise on test files and on files that belong to the requested feature. Words that appear in more than 5% of the repo's paths (app names like `driver`) do not anchor files on their own.
- Sensitive files (infra, auth, payments, migrations, CI, `.env`) need direct evidence to be in scope; sitting next to an in-scope file is not enough. Files in scratch folders (`.scratch/`, `tmp/`) are grouped as `scratch-file` with one summary line instead of being flagged one by one.
- `against-instruction` flag: the agent changed a file you explicitly told it not to touch ("don't touch auth", "leave payments alone").
- README with logo, demo, comparison table and roadmap.
- Contributing guide, code of conduct, security policy, issue forms, pull request template.
- CI workflow running tests and type checks on Linux and macOS.
- Social preview image, `.gitattributes` and `.editorconfig`.

- Industry-grade CI: Biome lint and format, strict types, tests on Linux, macOS and Windows with an 85% coverage gate, dependency audit, TruffleHog secret scan, `typos`, actionlint and zizmor on workflows, CodeQL for code and workflows, dependency review, OpenSSF Scorecard, Dependabot with a 7-day cooldown, and a single required `CI OK` check. Every action is pinned to a commit hash; every job has least-privilege permissions.
- `bun run check` runs CI's required checks locally.

### Changed
- Removed the `unrequested?` flag, which fired on almost every file; the report's scope column says why each file is in scope instead.
- Codebase formatted with Biome; a few lint findings fixed (assignments inside expressions, a comma operator, unneeded regex escapes).
- Test fixture builds its fake API key at runtime, so no key-shaped text appears in the source.

### Fixed
- A session's change is now found the way people actually work: commits on any branch (not just the one checked out) that touch the session's files during the session, plus uncommitted edits to those files in any worktree. Previously the spike fell back to the whole dirty working tree, which mixed in other sessions' work and made line tracing look near 0%.
- When a commit also carries files the session never edited (another session's or a person's work), only the session's own files are reviewed; the rest are counted and named as left out.
- Lines that a parallel agent session wrote into the same file are credited to that session (named in the report) instead of being counted as untraced.
- Edits and test runs made by subagents (Task tool), stored in `<session>/subagents/`, are now part of the session.
- Uncommitted content identical to a commit already reviewed is no longer counted twice.
- Changes the agent made outside edit tools (scripts run through Bash, `sed`, `cp`) are traced through Claude Code's own file backups (`~/.claude/file-history`): what changed between two backups is credited to the turn in between.
- Uncommitted files are compared with Claude Code's backup from before the session touched them, not with HEAD, so local changes that were already there are not counted as the session's.
- Backup changes are credited to the agent only when it could have made them: an edit to that file or a file-writing shell command in that window. A backup-only line another session wrote with an edit tool goes to that session.
- Duplicate commits (rebase, cherry-pick, squash-merge copies) are detected with `git patch-id` and counted once; lines added and then rewritten across commits net out.
- Repeated lines (`}`, `return null;`) are no longer collapsed when uncommitted edits overlap a commit.
- A file back to its pre-session state no longer counts as an uncommitted edit.
- `--base` without `--head` includes untracked files again.
- All of a session's commits are read in one `git show` instead of two git calls per commit; commits beyond the 200 limit are named in the report instead of dropped silently.
- Transcripts that ended before a session's window are skipped without parsing.
- Edits made in sibling git worktrees are mapped back to the repo instead of being counted as outside it, and sessions started in a worktree are found too.
- Claude Code record types `file-history-delta` and `pr-link` are recognised.
- Git is always run with `--no-optional-locks`, so offscript never leaves lock files in your repo.
- Paths are compared after resolving symlinks and short names, so sessions are found when the repo is reached through a symlink (macOS `/var` vs `/private/var`) or a different spelling of the same folder.

## [0.0.1] - 2026-10-12

First spike.

### Added
- Claude Code transcript reader (checked against Claude Code 2.1.296): human prompts, assistant text, edits with before/after patches, shell commands and test runs, compaction markers; unknown record types counted, never fatal.
- Secret redaction for common key, token and credential formats.
- Intent ledger through the user's own Claude Code CLI in headless mode (`haiku`, safe mode, no tools, no session file). No API key needed.
- Hard facts from git: added, deleted and renamed files, removed symbols, dependency and sensitive-path changes.
- Test-integrity facts: assertion counts, `skip`/`only`/`xfail` added, deleted test files.
- Line provenance: each added line traced to the agent edit, turn and prompt that wrote it; human edits kept separate.
- Claim check for "tests pass" against test runs after the last edit.
- Per-session Markdown report with a labelling block, plus `spike:score` to compute the v0.1 gate.
