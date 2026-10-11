# Changelog

All notable changes to offscript are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- README with logo, demo, comparison table and roadmap.
- Contributing guide, code of conduct, security policy, issue forms, pull request template.
- CI workflow running tests and type checks on Linux and macOS.
- Social preview image, `.gitattributes` and `.editorconfig`.

- Industry-grade CI: Biome lint and format, strict types, tests on Linux, macOS and Windows with an 85% coverage gate, dependency audit, TruffleHog secret scan, `typos`, actionlint and zizmor on workflows, CodeQL for code and workflows, dependency review, OpenSSF Scorecard, Dependabot with a 7-day cooldown, and a single required `CI OK` check. Every action is pinned to a commit hash; every job has least-privilege permissions.
- `bun run check` runs CI's required checks locally.

### Changed
- Code is formatted and linted with Biome (`bun run lint`, `bun run format`).
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
