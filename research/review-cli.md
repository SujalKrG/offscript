# Module 4: `offscript review` CLI (plan)

## Research that shaped this

- **clig.dev (Command Line Interface Guidelines):**
  - Humans first, machines second.
  - Detect a TTY. Plain, stable output when piped.
  - `--json` for scripts.
  - Respect `NO_COLOR`.
  - Print something within 100 ms.
  - Suggest the next command.
  - Exit codes carry meaning.
- **Explainable AI code review (arXiv 2607.24601, n=34):**
  - Short feedback with brief reasons got the highest agreement (89%).
  - Full explanations raised perceived trust but made people agree less.
  - **Decision:** the default view is short (verdict plus one line of evidence per issue). Full detail sits behind `--full` or the markdown report.
- **AgentLens (arXiv 2607.06624):**
  - Pair objective checks with readable, trajectory-level reasons.
  - Review on these axes: instruction following, verification of own work, communication.
  - **Decision:** our three headline questions map to those axes.
- **OverclaimBench and Advani (module 3):** deterministic evidence beats LLM judges. So the review never needs an LLM except to split prompts into requests.
- **Claude Code hooks:**
  - SessionEnd input carries `transcript_path`, `session_id` and `cwd`.
  - SessionEnd has a 1.5 s default budget, raisable to 60 s with `timeout`.
  - `systemMessage` shows a line to the user.
  - **Decision:** the hook calls `offscript review --hook`, which reads stdin JSON, reviews that exact session, writes the report and prints one line.
- **Bun:**
  - `bun build --compile --bytecode` starts 1.5-2x faster.
  - Bytecode is version-locked, so it is built in CI only (module release, not now).

## Where the time goes, and the low-overhead design

| Step | Cost | Plan |
|---|---|---|
| Parse transcript, git | 0.2-3 s | Keep. It is already batched. |
| Intent ledger (`claude -p`) | 10-60 s and money | **Content-addressed disk cache:** key = sha256(model + prompts + agent final text + prompt version). Re-reviews are instant. `--no-llm` falls back to a heuristic ledger (one request per non-follow-up prompt) so the whole review is offline and under 3 s. |
| Report render | ms | Keep. |

- **Cache location:** `$XDG_CACHE_HOME/offscript`, else `~/.cache/offscript`, else `%LOCALAPPDATA%\offscript` on Windows.
- **Format:** one JSON file per key. Writes are atomic: write to a tmp file, then rename.

## Commands

```
offscript review [session-id-prefix]   review the latest session in this repo (or the one named)
  --repo <path>     default: cwd
  --no-llm          offline heuristic ledger, no claude call
  --full            print every claim and flag, not just problems
  --json            machine output (stable schema, version field)
  --md <file>       also write the markdown report (default: .offscript/reports/<date>-<id>.md)
  --hook            read Claude Code hook JSON from stdin, review that session, print one line
  --fail-on <lvl>   exit 1 when: never (default) | problems | any (opt in for CI)
offscript list      sessions for this repo: id, date, prompts, edits
offscript hook install [--project|--user]   add a SessionEnd hook to .claude/settings.json (merge, never overwrite)
```

## Terminal view (TTY), short by default

```
offscript  a1b2c3d4  2026-10-20 14:02  18 requests, 32 edits, 96% traced

  Did what you asked    ✔ 12 done  ◐ 2 partly  ✘ 1 not done
  Only what you asked   ✔ no unexplained files
  Told the truth        ✘ 1 contradicted  ~ 2 stale  ? 1 silent gap

  Problems
  ✘ I7 "merge to develop"  not done: the merge failed (gh pr merge 42)
  ~ "All tests pass"       stale: 3 edits after the last test run
  ? I9 "add the footer"    partly done, never mentioned

  Full report  .offscript/reports/2026-10-20-a1b2c3d4.md
```

- Show at most 8 problems, then "+N more (--full)".
- Glyphs fall back to ASCII (`[x] [~] [?] [ok]`) when the terminal is not UTF-8 or `NO_COLOR` is set.
- A spinner goes to stderr only while the ledger runs, and only on a TTY.

## Exit codes

- 0: reviewed. This is the default even when problems were found, so `bun run offscript review` does not print "error: script exited with code 1" for a normal interactive review.
- 1: problems found, only with `--fail-on problems` (or `any`, which also counts notes). Use it in CI.
- 2: usage error.
- 3: no session found.

## Structure

- `packages/core/src/review.ts`
  - `reviewSession(opts): Promise<ReviewResult>`, the pipeline extracted from spike.ts `main()` so spike and the CLI share it.
  - `ReviewResult` holds `{ session meta, verdicts, claims, flags, facts, provenance, markdown }`.
- `packages/core/src/cache.ts`: `cacheDir()`, `getCached(key)`, `putCached(key, value)`.
- `packages/core/src/intent.ts`:
  - Wrap `buildIntentLedger` with the cache.
  - Add `heuristicLedger(session)` for `--no-llm`.
- `packages/cli/` holds the `offscript` package with `bin: { offscript: "src/main.ts" }`.
  - `main.ts`: arg parse with `node:util parseArgs`, no deps. Lazy-imports core.
  - `render.ts`: `renderTerminal(result, {color, unicode, full})`, a pure function.
  - `json.ts`: `toJson(result)`, `schemaVersion: 1`.
  - `hook.ts`: stdin parse plus install/merge settings.
- spike.ts calls `reviewSession`, so there is no duplicated pipeline.
- Root package.json gets an `offscript` script: `bun packages/cli/src/main.ts`.

## Tests (bun test, fixture-based, no network)

- `review` on the fixture: TTY render snapshot (no color), `--json` schema, exit codes.
- Cache:
  - A second run does not call the fake claude (count invocations).
  - A changed prompt misses the cache.
  - The atomic write leaves no tmp files.
- `--no-llm`: the heuristic ledger yields one intent per non-follow-up prompt, and nothing is spawned.
- `--hook`: stdin JSON with transcript_path reviews that session.
- `hook install`: merges into existing settings without dropping keys, and is idempotent.
- Render:
  - ASCII fallback under NO_COLOR.
  - Problems are capped at 8 with "+N more".
- Coverage gate stays at 85% or above.
