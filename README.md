# offscript

**Catch your coding agent going off-script.**

Did your agent do what you asked, only what you asked, and did it tell you the truth?

Open-source tool that reads the Claude Code (later Codex) session that produced a change and checks it against the change itself:
1. **Intent:** what you asked for, taken from your prompts, never guessed from the code.
2. **Unrequested changes:** what the agent changed that nobody asked for, and whether it told you.
3. **Claims vs evidence:** "all tests pass" is checked against the test runs actually in the session.
4. **Provenance:** which turn and prompt wrote each changed line; your own edits are kept separate.
5. **Where to look first:** the few places that matter.

No API key needed: it uses your installed Claude Code login in headless mode on the cheapest model. Everything that doesn't need judgment runs offline with no model at all.

Status: **v0.0 spike.** Research and design are done (see `research/`).
Author: Sujal ([@SujalKrG](https://github.com/SujalKrG)). Part of the Vectorvane family, works fully on its own. Apache 2.0.

---

## Run the v0.0 spike

Requirements: [Bun](https://bun.sh) 1.4+, git, and Claude Code installed and logged in (for intents; use `--no-llm` without it).

```powershell
cd C:\Users\sujal\Desktop\offscript
bun install
bun test

# list Claude Code sessions recorded for a repo
bun run spike --repo C:\path\to\your-repo --list

# build reports for the 10 most recent sessions that edited that repo
bun run spike --repo C:\path\to\your-repo --limit 10
```

Reports go to `spike-results\<repo-name>\`, one Markdown file per session plus `summary.md`. That folder is gitignored because it contains excerpts of your private sessions (secrets are redacted first).

Each report has:
1. the intent ledger (from your prompts and CLAUDE.md only; the model never sees code),
2. the agent's claims vs evidence,
3. hard facts from git (deleted files, removed exports, dependency and sensitive-path changes, test skips and assertion counts),
4. provenance: which turn wrote each file's lines, whether you named the file, whether the agent mentioned it,
5. your prompts, for labelling,
6. a label block.

### Label and score

Fill in the label block at the bottom of each session report, then:

```powershell
bun run spike:score
```

Gate to start v0.1: at least 6 of 10 sessions with correct intents, and at least 80% of added lines traced to an agent edit.

### Options

| flag | meaning |
|---|---|
| `--repo <path>` | repo to review (default: current folder) |
| `--limit <n>` | number of sessions (default 10) |
| `--session <id-prefix>` | one specific session |
| `--base <ref> --head <ref>` | review an explicit range instead of auto-detecting |
| `--no-llm` | skip the model; facts and provenance only |
| `--include-empty` | include sessions with no edits |
| `--out <dir>` | output folder (default `spike-results`) |

Environment: `CLAUDE_CONFIG_DIR` if your Claude Code data isn't in `~/.claude`; `OFFSCRIPT_CLAUDE_BIN` to point at a specific `claude` binary; `OFFSCRIPT_MODEL` to change the model (default `haiku`).

### How the change for a session is chosen

1. `--base/--head` if given.
2. Commits made on the current branch during the session (plus 2 hours): parent of the first one up to the last one, extended to the working tree if the session also left uncommitted edits.
3. Otherwise uncommitted changes vs HEAD.

---

## Research
- `research/arctic-deep-study.md`: Meta's ARCTIC system, reverse engineered
- `research/gaps-complaints-feasibility.md`: what Meta left unsolved, developer complaints, feasibility
- `research/design-spec.md`: end-to-end design, stack, innovations, publishing plan

## Layout
```
packages/core/src/
  ingest/claude-code.ts   transcript reader (format checked on Claude Code 2.1.296)
  redact.ts               secret redaction before anything is stored or sent
  git.ts                  diff range per session, unified diff parser
  facts.ts                deterministic facts (no model)
  provenance.ts           added line -> agent edit -> turn -> prompt
  checks.ts               test evidence, claim verdicts, file flags
  intent.ts               intent ledger (conversation only)
  judge/claude-cli.ts     headless Claude Code backend (no API key)
  report.ts               Markdown report + label block
  spike.ts                spike entry point
  score-labels.ts         reads your labels, prints the gate result
packages/core/test/       fixture repo + transcript, end-to-end tests
```
