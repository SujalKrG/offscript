# Contributing to offscript

Thanks for helping. offscript is early (v0.1 in progress), so the most valuable contributions right now are **evidence**: real sessions where an agent went off-script, and verdicts offscript got wrong.

## Ways to help

| Contribution | Where |
|---|---|
| A case where your agent went off-script (redacted) | [Open an "Off-script case" issue](../../issues/new?template=wrong_verdict.yml) |
| offscript flagged something wrongly, or missed something | Same form, choose "false positive" or "missed" |
| A bug in the CLI, the spike or the parser | [Bug report](../../issues/new?template=bug_report.yml) |
| An idea | [Feature request](../../issues/new?template=feature_request.yml) |
| Code | Pull request (read below first) |

## Development setup

Requirements: [Bun](https://bun.sh) 1.4+, git. Claude Code is optional. Only the step that splits your prompts into requests uses it; `--no-llm` skips it.

```bash
git clone https://github.com/SujalKrG/offscript.git
cd offscript
bun install
bun run check      # CI's required checks locally: lint + format, strict types, tests with the 85% coverage gate
```

Individually:

```bash
bun test           # unit and end-to-end tests on a throwaway repo and transcript
bun run typecheck  # strict TypeScript
bun run lint       # Biome: lint, formatting, import order (fails on any difference)
bun run format     # fix formatting and safe lint issues in place
```

### What CI checks

Every pull request runs these. **CI OK** is the single required check; it passes only when all of the others do.

| Check | What it enforces |
|---|---|
| Lint, format, types | Biome lint and formatting, strict TypeScript |
| Test (Linux, macOS, Windows) | Full test suite on all three; Linux also enforces at least 85% line and function coverage |
| Dependency audit | Lockfile in sync, no known vulnerability of moderate severity or above |
| Secret scan | TruffleHog over the full history: no live or unverifiable credentials |
| Spelling | `typos` over code and docs |
| Workflow lint and security | actionlint (with shellcheck) and zizmor over `.github/` |
| CodeQL | Static analysis of the TypeScript and of the workflows |
| Dependency review | No new dependency with a known vulnerability or a copyleft license |

A non-blocking job also runs the tests on the latest Bun release, to catch breakage early. OpenSSF Scorecard runs weekly.

Run offscript against a repo of yours:

```bash
bun run offscript review --repo /path/to/repo            # latest session with edits
bun run offscript review --repo /path/to/repo --no-llm   # no model at all
bun run offscript list --repo /path/to/repo              # sessions, to pick one by id prefix
```

The spike is kept for collecting labelled cases. It writes a Markdown report per session with a labelling block, always asks the model fresh, and scores your labels:

```bash
bun run spike --repo /path/to/repo --limit 3
bun run spike:score
```

Reports go to `.offscript/reports/` (CLI) or `spike-results/` (spike). Both are gitignored here; in your own repo, add `.offscript/` to `.gitignore`.

## The five rules

Every change must keep these true. PRs that break one will be asked to change, however useful they are otherwise.

1. **Deterministic evidence first.** If something can be computed from git or the transcript, compute it. Never let a model overrule a computed fact.
2. **The model only splits prompts into requests, and never sees code.** Do not send the diff or file contents to a model. Do not add a model step without discussing it first.
3. **Evidence or silence.** Every finding cites a prompt quote, a command or a changed file. No style, naming or "best practice" comments.
4. **"Needs judgment" and "not checked" instead of guessing.** If the evidence does not settle it, say so. Do not return "done" or "kept" without proof.
5. **Privacy by default.** Redact before storing, printing or sending anything. Raw transcripts never leave the user's machine. Never log prompt text in errors.

Docs follow the same standard. offscript exists to catch agents overclaiming, so a README or changelog line must match what the code does today. Mark anything not built as planned.

## Code layout

```
packages/core/src/
  ingest/claude-code.ts   transcript reader
  redact.ts               secret redaction
  git.ts                  session change: commits, uncommitted edits, diff parser
  facts.ts                deterministic facts
  provenance.ts           added line -> agent edit -> turn -> prompt
  scope.ts                anchor, related, derived, scratch, drift; against-instruction
  verdicts.ts             verdict per request, from evidence
  claims.ts               claim check and silent gaps
  checks.ts               test evidence, file flags
  intent.ts               request list: model (prompts only) or heuristic
  cache.ts                content-addressed cache for the request list
  judge/claude-cli.ts     headless Claude Code backend
  review.ts               the review pipeline shared by the CLI and the spike
  report.ts               Markdown report
  spike.ts, score-labels.ts   labelling spike and its scorer
packages/cli/src/
  main.ts                 commands, flags, exit codes
  hook.ts                 SessionEnd hook input, output and install
  render.ts, summary.ts, json.ts   terminal view, shared numbers, JSON
packages/core/test/       fixtures and tests
research/                 design and research notes
```

## Transcript formats change

Claude Code and Codex change their session formats without notice. If you hit a parse problem:

1. Run `offscript review`; unknown record types are listed at the top of the Markdown report.
2. Add a **minimal, synthetic** fixture to `packages/core/test/fixture.ts` that reproduces it. Never commit a real transcript.
3. Note the CLI version in the test name.

## Sharing a real session safely

Real cases are gold, but they contain your code and prompts. Before sharing:

- Share the **report** from `.offscript/reports/` (or `spike-results/`), not the raw `.jsonl`.
- Remove client names, file paths and anything you would not post publicly.
- Never paste keys, even revoked ones. offscript redacts common formats, but check anyway.

## Pull requests

- One topic per PR. Small is better.
- Add or update tests. `bun run check` must pass.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for titles: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Update `CHANGELOG.md` under **Unreleased** for user-visible changes.
- If you change a verdict rule, include a before/after example in the PR description.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Be kind, be specific, assume good intent.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
