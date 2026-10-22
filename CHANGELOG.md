# Changelog

All notable changes to offscript are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

#### Review CLI
- `offscript` command line (`packages/cli`, run with `bun run offscript`; no new dependencies).
  - `offscript review [session-id-prefix]` reviews the latest session in the repo (or the one named) and prints a short terminal view: three headline answers (did what you asked, only what you asked, told the truth), then at most 8 problems with one line of evidence each. `--full` prints every request, claim and flagged file. Piped output and `NO_COLOR` get plain ASCII glyphs; a UTF-8 terminal gets colour and Unicode. The view uses the real terminal width (default 100, minimum 60), and long quotes and evidence are cut on a word boundary with "...". Terminal escape codes in transcript text are stripped before printing.
  - The Markdown report is always written, by default to `.offscript/reports/<date>-<id>.md` (`--md <file>` moves it).
  - `--json` prints a machine-readable result with `schemaVersion: 1`.
  - `--fail-on never|problems|any` sets when the exit code is 1. The default is `never`, so a normal interactive review exits 0.
  - Exit codes: 0 reviewed, 1 problems found (only with `--fail-on`), 2 usage error, 3 no session found, 4 unexpected failure.
  - `--no-llm` runs fully offline. A heuristic ledger makes one request per prompt that is not a follow-up ("yes", "go ahead") and skips harness prompts (`[Request interrupted...]`, `<command-...>`, `Caveat:`, local command output). No `claude` process is started. Without the Claude Code CLI, or when the model call fails, the review falls back to the heuristic ledger and says so.
  - `offscript list` shows the repo's sessions (id, date, prompts, edits).
- Intent ledger cache. The only model use is splitting your prompts into requests, through your own Claude Code CLI (`haiku` by default, `OFFSCRIPT_MODEL` changes it). The result is stored by content (model, prompt version, your prompts, rules file, the agent's last message), so reviewing the same session again is instant and free. Entries are written atomically under `$XDG_CACHE_HOME/offscript`, `~/.cache/offscript` or `%LOCALAPPDATA%\offscript` (`OFFSCRIPT_CACHE_DIR` overrides). Failed model calls are never cached.
- Claude Code hook. `offscript hook install [--project|--user]` merges a `SessionEnd` hook (`"timeout": 60`) into Claude Code settings without touching other keys; running it again changes nothing. `offscript review --hook` reads the hook's JSON from stdin, reviews exactly that session, writes the report and prints one `systemMessage` line.
  - A hook never blocks the end of a session: it waits at most 5 s for stdin, caps the model call at 30 s, and turns every error into that one line with exit code 0.
- Windows hardening: settings files with a byte order mark are read, the hook command uses forward slashes, a timed-out model call has its whole process tree killed with `taskkill`, temp folder cleanup is best effort and cannot fail a review, `.cmd` paths with spaces are quoted, and native Windows root paths are handled.
- Secret redaction also covers errors from the model call, so a CLI error that echoes a prompt cannot leak a key to the terminal, JSON or report.
- `reviewSession()` in `packages/core/src/review.ts` holds the review pipeline that used to live in the spike script; the spike and the CLI share it, and the spike's output is unchanged.

#### Verdicts
- Verdict per request (report section 1b): done, partly done, failed, not done, not in change, answered, or needs judgment for tasks; kept, violated or not checked for constraints. Decided from independent evidence in that request's turns (code that landed, commit/push/PR/merge/test/type-check/build/deploy commands and whether they succeeded, substantive replies), never from the agent's own summary.
- Verdicts never say "done" without proof. A "fix X and commit" whose code is not in the change is "partly done"; a command with no recorded result is "needs judgment"; the last attempt decides, and earlier failures are noted. Constraints that cannot be checked from files are "not checked" instead of "kept". An answer must close the request's turns, not be progress narration.
- Actions are read only from clauses that start with an action verb, so "push notifications" or "commit message parser" are not git requests, and commands that merely mention a word (`cat deploy.yml`, `git merge-base`) do not count.
- Commands you ran yourself with Claude Code's `!` shell count as evidence (marked "you ran") and are not treated as prompts. Their output is read from stdout and stderr and attached only to the command right before it. When a test or deploy request shows no recognised run, the verdict lists the commands that did run.
- A file constraint must be a real "leave it alone" instruction: a touch verb (touch, change, modify, edit, rewrite, refactor, delete, remove, rename, move) after a negation, "leave X alone", or "keep X as is". "Without breaking them", "keep the apps working", "only capture screenshots" and "edited like the other apps" are goals and come out as "not checked". A file that another active request anchors is not flagged against an instruction.

#### Claims
- Claim check (report section 2a): claims in the agent's replies (tests pass, type check clean, committed, pushed, PR opened, merged, deployed, built, fixed, "only touched X", "everything is done") are checked against evidence from before the reply: verified, contradicted, stale (tests passed, then more edits), overstated, unsupported or unverified. Deterministic, following OverclaimBench and Advani 2026; notes in `research/claim-checks.md`.
- Silent gaps list requests left unfinished that the agent never mentioned.
- Claim tuning: CI results you read count as evidence (`gh pr checks`, `gh run list|watch|view`). Watching a deploy or fetching a live URL counts as evidence for a deploy claim. Sentences about history or descriptions (a past commit hash, a PR number, a date, a table row) are skipped, as are plans, conditions, questions and negations.

#### Scope
- Scope check per changed file: anchor (what you asked for), related (its test, an import either way, a sibling in a small folder, or something the agent told you about), derived (lockfiles, generated and housekeeping files), scratch or drift. Only drift is flagged `undisclosed`, which removes the noise on test files and on files that belong to the requested feature. Words that appear in more than 5% of the repo's paths (app names like `driver`) do not anchor files on their own.
- Sensitive files (infra, auth, payments, migrations, CI, `.env`) need direct evidence to be in scope; sitting next to an in-scope file is not enough.
- Files in scratch folders (`.scratch/`, `tmp/`) are grouped as `scratch-file` with one summary line instead of being flagged one by one.
- `against-instruction` flag: the agent changed a file you explicitly told it not to touch ("don't touch auth", "leave payments alone").
- Files no request explains are listed as extra work. The reason for an unexplained file is stated once.

#### Provenance and session change
- Session change selection: commits on any branch that touch the session's files during the session, plus uncommitted edits to those files in any worktree. Files in those commits that the session never edited are left out, counted and named in the report.
- Uncommitted files are compared with Claude Code's backup from before the session touched them when one exists, not with `HEAD`, so changes that were already there are not counted. A file back to its pre-session state is not an uncommitted edit.
- Duplicate commits (rebase, cherry-pick, squash-merge copies) are detected with `git patch-id` and counted once. Lines added and then rewritten across commits net out. Repeated lines (`}`, `return null;`) are not collapsed when uncommitted edits overlap a commit.
- Changes made outside edit tools (scripts run through Bash, `sed`, `cp`) are traced through Claude Code's own file backups (`~/.claude/file-history`) and credited to the turn in between, only when the agent could have made them. A backup-only line another session wrote with an edit tool goes to that session.
- Lines a parallel agent session wrote into the same file are credited to that session (named in the report) instead of being counted as untraced.
- Edits and test runs by subagents (Task tool), stored in `<session>/subagents/`, are part of the session.
- Edits made in sibling git worktrees are mapped back to the repo, and sessions started in a worktree are found too.
- All of a session's commits are read in one `git show`. Commits beyond the 200 limit are named in the report instead of dropped silently. Transcripts that ended before a session's window are skipped without parsing.
- Claude Code record types `file-history-delta` and `pr-link` are recognised.

#### CI and repo
- README with logo, demo, comparison table and roadmap. Contributing guide, code of conduct, security policy, issue forms, pull request template. Social preview image, `.gitattributes` and `.editorconfig`.
- CI: Biome lint and format, strict types, tests on Linux, macOS and Windows with an 85% coverage gate, dependency audit, TruffleHog secret scan, `typos`, actionlint and zizmor on workflows, CodeQL for code and workflows, dependency review, OpenSSF Scorecard, Dependabot with a 7-day cooldown, and a single required `CI OK` check. Every action is pinned to a commit hash; every job has least-privilege permissions.
- `bun run check` runs CI's required checks locally.
- Codebase formatted with Biome, with a few lint findings fixed.

### Changed
- The spike (`bun run spike`) now calls `reviewSession()`; its output is unchanged.
- Removed the spike's `unrequested?` flag, which fired on almost every file. The report's scope column says why each file is in scope instead.

### Fixed
- The spike fell back to the whole dirty working tree when a session's change was not found, which mixed in other sessions' work and made line tracing look near 0%. It now reviews only the session's own commits and files.
- `--base` without `--head` includes untracked files again.
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
