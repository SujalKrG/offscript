# Security policy

offscript reads coding-agent session transcripts. Those transcripts can contain source code, private prompts and, sometimes, secrets that were pasted or read during a session. Protecting that data is the project's first responsibility.

## Supported versions

| Version | Supported |
|---|---|
| `main` (v0.0 spike) | yes |
| anything older | no |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: go to the repository's **Security** tab and choose **Report a vulnerability**. You'll get an acknowledgement within 72 hours and a status update within 7 days.

Include:
- what you found and why it matters,
- steps or a minimal synthetic transcript to reproduce (never a real one),
- the offscript commit and your OS.

## What counts

Especially in scope:

- **Secret leakage:** a key, token or credential that survives redaction into a report, a log, an error message, or a model request.
- **Unredacted data sent to a model:** anything reaching the judge before redaction, or code reaching the intent step.
- **Command or argument injection:** transcript or repo content that changes the commands offscript runs (git, `claude`).
- **Hook loops or runaway spend:** a way to make offscript call itself, or call a model repeatedly.
- **Writes outside the output folder:** any path traversal from session or repo data.

Out of scope: vulnerabilities in Claude Code, Codex, git or Bun themselves (report those upstream), and issues that need an attacker who already controls your machine.

## How offscript handles your data

- Transcripts are read locally; nothing is uploaded by offscript.
- Secrets are redacted before anything is stored, printed or sent to a model.
- Judge calls run from an empty temporary folder, with tools, hooks and session persistence turned off.
- Reports are written to `spike-results/`, which is gitignored.
