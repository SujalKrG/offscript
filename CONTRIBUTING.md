# Contributing to offscript

Thanks for helping. offscript is early (v0.0 spike), so the most valuable contributions right now are **evidence**: real sessions where an agent went off-script, and verdicts offscript got wrong.

## Ways to help

| Contribution | Where |
|---|---|
| A case where your agent went off-script (redacted) | [Open an "Off-script case" issue](../../issues/new?template=wrong_verdict.yml) |
| offscript flagged something wrongly, or missed something | Same form, choose "false positive" or "missed" |
| A bug in the spike or parser | [Bug report](../../issues/new?template=bug_report.yml) |
| An idea | [Feature request](../../issues/new?template=feature_request.yml) |
| Code | Pull request (read below first) |

## Development setup

Requirements: [Bun](https://bun.sh) 1.4+, git. Claude Code is optional (only the intent step uses it).

```bash
git clone https://github.com/SujalKrG/offscript.git
cd offscript
bun install
bun test           # unit + end-to-end tests on a throwaway repo and transcript
bun run typecheck  # strict TypeScript
```

Run the spike against a repo of yours:

```bash
bun run spike --repo /path/to/repo --limit 3
bun run spike --repo /path/to/repo --no-llm   # no model at all
```

## The five rules

Every change must keep these true. PRs that break one will be asked to change, however useful they are otherwise.

1. **Facts before opinions.** If something can be computed from git or the transcript, compute it. Never let a model overrule a computed fact.
2. **Leakage rule.** Intent extraction never sees code. Code description never sees intents.
3. **Evidence or silence.** Every finding cites a prompt quote or a diff hunk. No style, naming or "best practice" comments.
4. **Abstain instead of guess.** If you can't be sure, the output is *uncertain*, not a guess.
5. **Privacy by default.** Redact before storing, printing or sending anything. Raw transcripts never leave the user's machine. Never log prompt text in errors.

## Code layout

```
packages/core/src/
  ingest/claude-code.ts   transcript reader
  redact.ts               secret redaction
  git.ts                  diff range per session, diff parser
  facts.ts                deterministic facts
  provenance.ts           added line -> agent edit -> turn -> prompt
  checks.ts               test evidence, claim verdicts, file flags
  intent.ts               intent ledger (conversation only)
  judge/claude-cli.ts     headless Claude Code backend
  report.ts               Markdown report
  spike.ts                spike entry point
packages/core/test/       fixtures and tests
research/                 design and research notes
```

## Transcript formats change

Claude Code and Codex change their session formats without notice. If you hit a parse problem:

1. Run the spike; unknown record types are listed at the top of each report.
2. Add a **minimal, synthetic** fixture to `packages/core/test/fixture.ts` that reproduces it. Never commit a real transcript.
3. Note the CLI version in the test name.

## Sharing a real session safely

Real cases are gold, but they contain your code and prompts. Before sharing:

- Share the **report** from `spike-results/`, not the raw `.jsonl`.
- Remove client names, file paths and anything you would not post publicly.
- Never paste keys, even revoked ones. offscript redacts common formats, but check anyway.

## Pull requests

- One topic per PR. Small is better.
- Add or update tests. `bun test` and `bun run typecheck` must pass.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for titles: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Update `CHANGELOG.md` under **Unreleased** for user-visible changes.
- If you change a verdict rule, include a before/after example in the PR description.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Be kind, be specific, assume good intent.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
