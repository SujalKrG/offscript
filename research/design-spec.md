# offscript: end-to-end design spec (v1)

Date: 11 Oct 2026. Research note 3. Reads after `arctic-deep-study.md` and `gaps-complaints-feasibility.md`.
Status: design locked for v0.0 to v0.3. Decisions are final unless the v0.0 spike disproves them.

One line: **"Did your agent do what you asked, only what you asked, and did it tell you the truth?"**

---

## 0. Decisions at a glance

| Area | Decision | Why |
|---|---|---|
| Language | TypeScript, strict | Sujal's core stack; same language as Claude Code plugins and GitHub Actions |
| Runtime | Core runs on Node 20+ and Bun. Bun is used for dev, tests and single-binary builds | `npx`/`bunx` users and binary users both covered; no Bun-only APIs in core |
| Packaging | npm package `offscript` (name is free on npm today) plus single binaries via `bun build --compile` | Binary means no Node install for Windows users; npm means one-line install for JS users |
| AST facts | `web-tree-sitter` 0.27 (MIT, WASM) plus grammars from `@vscode/tree-sitter-wasm` (MIT) | WASM embeds in the compiled binary and runs on every OS with no native builds. Grammars include TS, TSX, JS, Python, Go, PHP, Java, C#, Rust and Ruby |
| Diff | Shell out to `git diff --no-color --find-renames -U3`, parse with `parse-diff` (MIT) | git is always there; no reimplementation |
| Models | **No key required.** Backends, picked automatically in this order: (1) the user's installed agent CLI in headless mode (`claude -p` on Haiku, or `codex exec` on a mini model), (2) an API key via Vercel AI SDK `ai` v7 (Apache 2.0), (3) local Ollama, (4) none: facts-only mode. See section 1A | Most users already pay for Claude Code or Codex; zero setup on first install. Direct API stays the fastest, cheapest option |
| Schemas | Zod 4 | Same schema validates model output, JSON reports and config |
| Secrets | `secretlint` 13 recommended preset (MIT) plus our own rules for agent-specific tokens | Pure JS, no Go binary to ship |
| CLI | `commander` 15 | Most familiar to contributors; stable |
| Storage | Plain JSON under `.offscript/` in the repo (gitignored), receipts in git notes | No database to install; diffable; inspectable |
| Output | Terminal, Markdown, JSON (versioned schema), SARIF | SARIF means GitHub code scanning shows findings inline on the PR for free |
| Licence | Apache 2.0 | Matches the Vectorvane open-core decision; no AGPL code copied |

---

## 1. How it works, end to end

```
 you ── prompt ──> agent (Claude Code / Codex) ── edits ──> working tree
                          │                                  │
                  transcript JSONL                       git diff
                          │                                  │
        ┌─────────────────┴──────────────┐      ┌────────────┴───────────┐
        │ 1 Ingest + redact              │      │ 3 Facts (no model)     │
        │ 2 Intent ledger + constraints  │      │   deletions, exports,  │
        │   claims, test runs, edits     │      │   deps, config, tests  │
        └─────────────────┬──────────────┘      └────────────┬───────────┘
                          └──────────── 4 Provenance ─────────┘
                                 (hunk -> turn -> prompt)
                                          │
                          5 Backtranslate (diff only) -> task list
                                          │
                          6 Match + judge (3 shuffled runs, abstain)
                                          │
              7 Verify claims   8 Disclosure check   9 Spotlight
                                          │
                     10 Score (computed) + fix-prompt + receipt
                                          │
               terminal / markdown / JSON / SARIF / hook reply / git note
```

### 1A. Model backends (no API key needed)

The pipeline talks to one internal interface, `judge.run(task, zodSchema) -> typed result`. Four backends sit behind it.

| Order | Backend | Auth | Default model | When used |
|---|---|---|---|---|
| 1 | **Claude Code headless** | User's existing Claude login (subscription) | `haiku` alias | `claude` on PATH and `claude auth status` shows logged in |
| 1 | **Codex headless** | User's existing Codex login | mini model (e.g. `gpt-5.4-mini`) | `codex` on PATH |
| 2 | **API key** (AI SDK) | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or any OpenAI-compatible URL | Haiku 5.5 | Key present, or user prefers it |
| 3 | **Local** (Ollama, LM Studio) | none | user's choice | Fully offline use |
| 4 | **None: facts-only** | none | none | Nothing found. Model-only items show as "needs judgment", never guessed |

**Cross-family rule:** when both CLIs are installed, the judge is the *other* agent from the one that wrote the code (Claude wrote it, Codex judges; and the reverse). With only one, use its cheapest model, which is usually a different model from the one that wrote the code.

**Claude Code recipe** (flags checked against the current CLI reference):
```
claude -p \
  --model haiku \
  --safe-mode \                      # skips CLAUDE.md, hooks, plugins, MCP; keeps normal login
  --tools "" --disallowedTools "mcp__*" \
  --system-prompt-file <drift prompt> \
  --output-format json --json-schema '<schema>' \
  --no-session-persistence \         # the judge call leaves no transcript behind
  --max-turns 1 --max-budget-usd 0.05 \
  < redacted-input.txt
```
Read `.structured_output` from the JSON result; `total_cost_usd` gives an estimate for the budget guard.
Why `--safe-mode` and not `--bare`: `--bare` ignores the subscription login and needs an API key. `--safe-mode` keeps the login but still skips hooks, plugins and CLAUDE.md, which **prevents our own Stop hook from firing inside the judge call** (infinite loop) and keeps the repo's CLAUDE.md out of the judge's context.

**Codex recipe:**
```
codex exec - \
  --ephemeral --sandbox read-only --skip-git-repo-check \
  -c model=<mini model> \
  --output-schema schema.json -o result.json \
  < redacted-input.txt
```

**Safety rails for both:**
- Run from an empty temp directory, so no repo config, MCP file or instructions load, and nothing can be edited.
- Set `OFFSCRIPT_INNER=1`; offscript's own hooks exit immediately when they see it (second loop guard).
- Only redacted text is piped in; the judge never gets file access.
- Batch all items into as few calls as possible (each CLI start costs a few seconds). Target: at most 4 calls per check.

**Trade-offs, stated in the README:**
- It uses the user's plan usage. A typical check is a handful of small Haiku calls.
- It's slower than a direct API (process start per call): about 15 to 40 s per check versus about 10 to 20 s with a key. These are estimates; v0.1 measures them.
- Output schema support depends on CLI version; `offscript doctor` checks the version and falls back to the next backend.

`offscript init` detection order: installed agent CLIs (and which one wrote the session), then API keys in the environment, then Ollama on localhost, then facts-only. It prints what it picked and which checks are skipped.

### Stage 1. Ingest and redact
- Find sessions for the current repo: Claude Code `~/.claude/projects/<encoded-cwd>/*.jsonl`, Codex `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` filtered by `session_meta.cwd`. A hook passes `transcript_path` directly, so no search is needed there.
- Normalise both formats into one event stream: `HumanPrompt`, `AssistantText`, `ToolCall`, `ToolResult`, `FileEdit`, `Compaction`, `Meta`.
- Claude Code facts verified on a real 2026 transcript (this research session's own file):
  - human prompts are `user` records with `origin.kind = "human"`; injected text has `isMeta: true`; tool results are `user` records carrying `tool_result` blocks plus a `toolUseResult` object;
  - `toolUseResult` for edits carries `filePath`, `originalFile`, `structuredPatch` and `userModified`, which gives exact before/after per edit;
  - every record has `uuid`, `parentUuid`, `timestamp`, `gitBranch`, `cwd`, `version`.
- Redact with secretlint plus custom rules before anything else touches the text. Redaction is irreversible in memory; raw text never reaches a model.
- Parser per CLI version range, with fixtures. Unknown record types fail loudly in CI and warn at runtime.

### Stage 2. Intent ledger and constraints
- Input: human prompts (full), assistant plan or todo text (marked as agent-proposed), CLAUDE.md, AGENTS.md, `offscript.rules`. **The diff is never shown to this stage** (ARCTIC's leakage rule).
- One small-model call returns, via Zod schema:
  - `intents[]`: id, text (a why-statement), sourceMessageIds, quote (≤ 120 chars, redacted), status (active, superseded, cancelled), supersededBy, kind (task, constraint, preference);
  - `claims[]` from the final assistant messages: "all tests pass", "implemented X";
  - confidence: high (explicit prompts), medium (agent plan accepted by user), low (commit message or PR body only).
- Constraint compiler: rule lines that fit a pattern become deterministic checks ("don't touch `src/auth`" becomes a path rule; "no new dependencies" becomes a manifest rule). The rest stay as model-judged constraints.

### Stage 3. Facts (deterministic, free, offline)
From `git diff` plus tree-sitter on before/after versions of each touched file:
- files added, deleted, renamed; lines removed outside any file an intent mentions;
- exported symbols removed or renamed; function signatures changed; public routes changed;
- dependency manifests changed (package.json, lockfiles, requirements, go.mod, composer.json);
- sensitive paths touched (CI, Docker, migrations, env, auth, payments, infra), configurable;
- **test integrity**: test files changed, assertion count delta, skip/only/xfail added, expected literals changed in the same turn as a failing run, equality or matcher overrides added.

Facts are never overridden by a model. A deleted export is a deleted export.

### Stage 4. Provenance (the part nobody else has)
- Replay `FileEdit` events in order (from `structuredPatch` and `originalFile`) and map every final hunk to the edit and turn that produced it, plus the human prompt just before that turn.
- Hunks no edit tool produced are classified:
  - `bash-made` when a shell command in that turn touched the file (sed, scripts, codegen; detected by snapshot diff around the command);
  - `human` otherwise. Human hunks are never blamed as drift.
- Result: each hunk has `turn`, `promptId`, `author` (agent, bash, human), `overwrittenLater`.

### Stage 5. Backtranslation
- A small model reads **only the diff** (chunked per file) and writes a numbered list of what the change does, as if it were instructions. It never sees intents.

### Stage 6. Match and judge
- Two-way coverage:
  - intents to hunks: each intent is met, partial or unmet, with evidence hunk ids;
  - hunks to intents: every hunk that maps to no intent becomes an **unrequested change** candidate.
- Each question is asked per item, never "score this diff". Three runs with shuffled item order; a verdict counts only when the runs agree, otherwise the item is `uncertain`. Uncertain items can escalate once to a mid model.
- Unrequested changes are classified risky or benign by rules first (Stage 3 facts and `offscript.rules`), model second.

### Stage 7. Claim verification
Each claim is checked against evidence in the transcript and diff:
- "tests pass": was a test command run after the last edit, and did it exit 0? Test commands are detected from package scripts and common runners;
- "implemented X": the matching intent's verdict;
- a number or result claim: does the tool output in the transcript contain it?

Verdicts are `verified`, `contradicted` or `unverified`. Nothing is marked true without evidence.

### Stage 8. Disclosure check
Compare what the agent said it changed (assistant text, final summary) with what the diff contains. A risky unrequested change that the agent never mentioned is the top finding: **undisclosed**.

### Stage 9. Spotlight
Ranked, capped at 5:
1. undisclosed risky changes;
2. test-integrity hits;
3. hunks behind unmet or partial intents;
4. constraint violations;
5. one critic-filtered pass over remaining hunks for correctness, security and performance only. No style, ever.

### Stage 10. Score, fix-prompt and receipt
- Score is computed from items (weights per partial or unmet intent, per risky change, per contradicted claim, per test-integrity hit), then mapped to ARCTIC's 5 buckets for comparison. The checklist is shown first, the number last.
- **Fix-prompt**: a ready-to-paste message back to the agent ("You did not finish X. Revert the changes to Y, which I did not ask for. Run the tests and show the output."). In hook block mode this is fed to the agent automatically.
- **Receipt**: a compact JSON summary written to `refs/notes/offscript` on the commit (see 2.4).

---

## 2. The innovations, and why each matters

| # | Innovation | What it solves | Nobody else has it because |
|---|---|---|---|
| 2.1 | **Hunk provenance**: every changed line traced to the turn and prompt that wrote it; human vs agent vs bash split | "Why is this here? Did I ask for it?" | ARCTIC sees only the final diff; Git AI and Entire record links but never judge |
| 2.2 | **Say vs do (disclosure check)** | Silent out-of-scope edits (#64473) | Requires both the transcript and the diff, read separately |
| 2.3 | **Claim ledger**: completion claims checked against tool results | "It said done and it wasn't" (#69488) | Stop-hook verifiers check one thing (tests ran); none tie claims to diff and evidence |
| 2.4 | **Drift receipts in git notes**: the check runs locally where the transcript lives; a signed-off summary rides with the commit; CI reads the receipt, never the transcript | CI has no transcript, and teams should not upload chats | Every other tool either needs the chat in CI or ignores it |
| 2.5 | **Two-way coverage** (intents to hunks and hunks to intents) | Missed intents and unrequested changes caught from both sides | ARCTIC scores one direction with a single number |
| 2.6 | **Constraint compiler** from CLAUDE.md and AGENTS.md | "I told it not to" (#54240) | Nobody parses these files into checks |
| 2.7 | **Test-integrity sentinel** | Agents editing tests to pass | Bug-hunting reviewers don't look for it |
| 2.8 | **Facts-first, abstain-don't-guess judging** | Noise; middle-bucket errors | Most tools ask one model for one score |
| 2.9 | **Fix-prompt loop**: findings become the next instruction to the agent | Turns review into correction while context is warm | Reviewers stop at comments |
| 2.10 | **Drift Bench**: open mutation benchmark with exact labels | No public way to measure intent drift | ARCTIC's data cannot be released |

Receipt shape (git note on the commit):
```json
{
  "schema": "offscript-receipt/1",
  "tool": "offscript@0.3.0",
  "commit": "<sha>",
  "treeDiffHash": "sha256:<hash of the checked diff>",
  "sessions": ["claude-code:<sessionId>"],
  "intents": { "met": 4, "partial": 1, "unmet": 0, "uncertain": 0 },
  "risky": 1, "undisclosed": 1, "testIntegrity": 0,
  "claims": { "verified": 1, "contradicted": 1, "unverified": 0 },
  "bucket": "Significant", "score": 58,
  "createdAt": "2026-10-11T18:00:00Z"
}
```
CI recomputes the diff hash; a stale or missing receipt is reported as "not checked". No transcript content is stored in the note beyond counts.

---

## 3. How people use it

| Moment | Command or setup | What they see |
|---|---|---|
| Install | `npm i -g offscript`, or `brew install`, `scoop install`, or download a binary | |
| Setup | `offscript init` | Detects Claude Code or Codex login (no key needed), else API key, else Ollama, else facts-only; writes `.offscript/config.json`; offers to install hooks |
| End of every agent turn | Claude Code or Codex Stop hook (report mode) | One line when clean; findings when not |
| Before commit | `offscript check` | Full report: intents, unrequested changes, claims, tests, top 5 hunks, score |
| Fix | `offscript fix-prompt` (or automatic in block mode) | Paste-ready message to the agent |
| Commit | `offscript receipt` (or automatic via a post-commit hook) | Receipt stored in `refs/notes/offscript` |
| PR | GitHub Action | PR comment plus SARIF findings inline; "not checked" if no receipt |
| Explain a line | `offscript why src/x.ts:42` | Turn, prompt quote, and whether it was asked for |

CLI surface (v1):
```
offscript init                    set up provider, key, hooks
offscript check [--base main] [--session <id>] [--json|--md|--sarif]
offscript why <file>:<line>
offscript fix-prompt
offscript receipt [--push]
offscript hook claude|codex [--mode report|block]
offscript sessions                list sessions linked to this repo
offscript bench run|gen           benchmark tools
```

Config `.offscript/config.json`:
```json
{
  "backend": "auto",
  "backends": {
    "claude-cli": { "model": "haiku" },
    "codex-cli": { "model": "<mini model>" },
    "api": { "provider": "anthropic", "small": "claude-haiku-5-5", "escalate": "claude-sonnet-5-5" },
    "local": { "baseUrl": "http://localhost:11434/v1", "model": "<local model>" }
  },
  "crossFamilyJudge": true,
  "sensitivePaths": ["src/auth/**", "migrations/**", ".github/**"],
  "block": { "on": ["undisclosed-risky", "test-integrity", "contradicted-claim"] },
  "budget": { "maxUsdPerCheck": 0.05 }
}
```

---

## 4. Repo layout

```
offscript/                 (bun workspaces, Apache 2.0)
├── packages/
│   ├── core/                   pipeline, no I/O assumptions
│   │   ├── ingest/             claude-code/, codex/, adapters/ (entire, git-ai, agent-trace later)
│   │   ├── redact/
│   │   ├── intent/             ledger, constraint compiler
│   │   ├── facts/              git, tree-sitter queries per language, test-integrity rules
│   │   ├── provenance/
│   │   ├── judge/              backtranslate, match, consensus, escalate
│   │   ├── verify/             claims, disclosure
│   │   ├── spotlight/
│   │   ├── score/
│   │   └── report/             terminal, md, json, sarif, receipt
│   ├── cli/                    commander entry, binary build
│   └── action/                 GitHub Action (reads receipts, posts comment, uploads SARIF)
├── plugins/
│   ├── claude-code/            .claude-plugin/plugin.json, hooks, /drift skill
│   └── codex/                  .codex-plugin/plugin.json, hooks/hooks.json, skill
├── bench/                      Drift Bench generator, datasets, harness, results
├── fixtures/                   redacted real transcripts per CLI version + expected reports
├── schemas/                    JSON Schemas for report and receipt
└── docs/
```

---

## 5. Quality bar and testing

- **Unit**: parsers against fixtures per CLI version; facts against small before/after code pairs per language.
- **Golden reports**: fixture session plus diff produces the same report (model calls recorded and replayed, so CI costs nothing).
- **Drift Bench** (CI nightly with a real model): risky-change recall at least 0.9, middle-bucket F1 above 0.5 (ARCTIC 0.34 to 0.41), uncertain rate under 20%, median cost under $0.05, median time under 30 s.
- **Dogfood**: every Vectorvane and offscript change is checked by offscript; outcomes logged.
- **Budget guard**: abort with partial facts-only report if the cost estimate exceeds `maxUsdPerCheck`.
- **Privacy tests**: seeded fake secrets in fixtures must never appear in any model request (asserted on recorded requests).

Cost per typical check with Haiku 5.5 ($0.10 / $0.50 per million tokens): about $0.008, about $0.03 with one escalation to Sonnet 5.5 (worked in note 2).

---

## 6. Drift Bench (the credibility engine)

- Seeds: clean, intent-matched changes from three sources: SWE-bench style issue plus gold patch pairs; AIDev agent PRs with linked issues (licence to be confirmed before redistribution); and Sujal's own sessions (private until redacted and reviewed).
- Mutators (each yields exact labels): drop an intent's hunks (unmet), drop half (partial), add an out-of-scope edit in another module (risky unrequested), add a null check (benign unrequested), delete an export (severe), weaken or skip a test (integrity), add a false completion claim to the transcript (contradicted claim), hide a change from the summary (undisclosed).
- Published: generator code in the repo, dataset on Hugging Face, results table in the README, and a short tech report.

---

## 7. Where to publish

| Channel | What goes there | Notes |
|---|---|---|
| GitHub `SujalKrG/offscript` | Source, issues, releases with binaries for 6 targets (win x64/arm64, mac arm64/x64, linux x64/arm64) | Public repo under your name as founder |
| npm `offscript` | CLI package | Name confirmed free on npm today |
| Claude Code: own marketplace | `.claude-plugin/marketplace.json` in the repo; users run `claude plugin marketplace add SujalKrG/offscript` | Works the day you push |
| Claude Code: Anthropic community marketplace | Submit via the Console form (platform.claude.com/plugins/submit) | Listed in `anthropics/claude-plugins-community`, pinned to a commit. The official marketplace takes no direct submissions |
| Codex: own marketplace | `.agents/plugins/marketplace.json`; users run `codex plugin marketplace add SujalKrG/offscript` | OpenAI's official directory is not self-serve yet. Plugin hooks need the `codex_hooks` feature flag |
| GitHub Marketplace | The Action | Teams find it here |
| Homebrew tap and Scoop bucket | Binaries | Scoop matters for Windows developers |
| Hugging Face | Drift Bench dataset | Makes the benchmark citable and reusable |
| arXiv (cs.SE) | Short tech report: open reconstruction of ARCTIC plus Drift Bench results | First-time submitters may need an endorser |
| Launch | Show HN, r/ClaudeAI, r/ChatGPTCoding, X, LinkedIn, dev.to write-up with benchmark numbers; PRs to awesome-claude-code style lists | A 2025 study of 138 AI-tool launches found about 289 stars in the first week on average after HN exposure; posting time mattered and the "Show HN" tag did not |

Launch order: binaries, npm and both plugin marketplaces first; then the benchmark post with numbers; then HN and Reddit on the same day; community-marketplace submission the same week.

---

## 8. Milestones

| Version | Scope | Gate to move on |
|---|---|---|
| v0.0 spike (2 to 3 days) | Claude Code ingest, redaction, intent ledger, facts, provenance; print for 10 real sessions | At least 6 of 10 sessions give intents Sujal agrees with; provenance covers at least 80% of hunks |
| v0.1 (1 to 2 weeks) | Backtranslate, match, consensus judge, unclaimed hunks, claims, test integrity, MD and JSON report, Drift Bench generator | Risky-change recall at least 0.9 on the bench |
| v0.2 | Codex ingest, hooks for both, constraints, disclosure, spotlight, fix-prompt, Python and Go facts, SARIF | Dogfooded for 2 weeks with fewer than 1 in 5 findings dismissed |
| v0.3 (public launch) | Receipts, GitHub Action, binaries, plugin marketplaces, bench results, tech report | Launch |
| v0.4 | Entire, Git AI and Agent Trace adapters; optional local judge (Ollama) presets | Adoption signals for a team tier (see product note) |

---

## 9. Risks specific to the design

| Risk | Mitigation |
|---|---|
| Transcript formats change (seen already: Claude Code fields differ from 2025 write-ups) | Versioned parsers, fixture per CLI version, loud failure in CI, adapter for Entire as fallback |
| `web-tree-sitter` and grammar wasm versions must match | Pin both; test load of every grammar in CI |
| Bun binaries are large | Acceptable for a dev tool; `--minify`; npm package stays small |
| Hooks loop or nag | Report mode default; respect `stop_hook_active`; block only on the 3 high-severity classes |
| Model output drifts across providers | Zod schemas with retry; recorded-response tests per provider |
| Headless CLI flags change or a judge call recurses into our own hook | Pin a minimum CLI version, `offscript doctor` checks flags, `--safe-mode` plus `OFFSCRIPT_INNER=1` loop guard, fall back to the next backend on any error |
| Users worry about plan usage | Show the estimated cost and call count per check; `--facts-only` flag; cap with `maxUsdPerCheck` |
| Name clash | Final name `offscript` (free on npm, PyPI, crates.io, Homebrew as of 12 Oct 2026). A same-name Mac productivity app (offscript.tech) and its `offscript-ui` npm package exist in other categories: always say "offscript CLI" or "offscript for Claude Code", reserve the npm name early. Trademark risk only if offscript itself becomes the paid product |

---

## Sources
- Bun single-file executables https://bun.com/docs/bundler/executables
- web-tree-sitter vs native tree-sitter https://instagit.com/Egonex-AI/Understand-Anything/difference-web-tree-sitter-wasm-native-tree-sitter-parsing.md
- AI SDK structured data https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data
- Claude Code hooks https://code.claude.com/docs/en/hooks
- Claude Code plugin marketplaces https://code.claude.com/docs/en/plugin-marketplaces
- Publish a Claude Code plugin https://code.claude.com/docs/en/plugins/publish
- Codex plugin ecosystem https://codex.danielvaughan.com/2026/05/04/codex-cli-plugin-ecosystem-building-distributing-marketplace-plugins/
- Codex hooks after GA https://codex.danielvaughan.com/2026/05/25/codex-cli-hooks-after-ga-event-model-trust-verification-production-patterns/
- Codex rollout format https://codex.danielvaughan.com/2026/06/01/codex-cli-session-history-local-search-rollout-format-knowledge-mining/
- Anthropic API pricing https://platform.claude.com/docs/en/about-claude/pricing
- Hacker News launch study (138 AI tool repos) https://arxiv.org/abs/2511.04453v1
- AIDev dataset https://arxiv.org/html/2602.09185v1
- Package versions and licences checked on the npm registry on 11 Oct 2026: ai 7.0.137, @ai-sdk/anthropic 4.0.78, @ai-sdk/openai-compatible 3.0.67, web-tree-sitter 0.27.1, @vscode/tree-sitter-wasm 0.3.1, parse-diff 0.12.0, zod 4.6.6, commander 15.0.0, secretlint 13.0.7
