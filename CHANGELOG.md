# Changelog

All notable changes to offscript are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- README with logo, demo, comparison table and roadmap.
- Contributing guide, code of conduct, security policy, issue forms, pull request template.
- CI workflow running tests and type checks on Linux and macOS.
- Social preview image, `.gitattributes` and `.editorconfig`.

### Changed
- Test fixture builds its fake API key at runtime, so no key-shaped text appears in the source.

### Fixed
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
