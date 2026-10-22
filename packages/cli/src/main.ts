#!/usr/bin/env bun
// offscript: did your coding agent do what you asked, only what you asked, and did it tell you the truth?
//
//   offscript review [session-id-prefix] [--repo <path>] [--no-llm] [--full] [--json] [--md <file>] [--hook] [--fail-on never|problems|any]
//   offscript list [--repo <path>] [--limit <n>] [--json]
//   offscript hook install [--project|--user] [--repo <path>]
//
// Exit codes: 0 reviewed (default, or --fail-on never), 1 problems found (only with --fail-on problems|any), 2 usage error, 3 no session found, 4 unexpected failure.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HOOK_MODEL_TIMEOUT_MS, HOOK_STDIN_TIMEOUT_MS, hookCommand, hookMessage, hookOutput, installHook, parseHookInput, settingsPath } from "./hook.ts";
import { toJson } from "./json.ts";
import { detectTerm, renderTerminal } from "./render.ts";
import { summarize } from "./summary.ts";

export const EXIT = { ok: 0, problems: 1, usage: 2, noSession: 3, failed: 4 } as const;

export interface Io {
  out(s: string): void;
  err(s: string): void;
  readStdin(): Promise<string>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  outIsTTY: boolean;
  errIsTTY: boolean;
  /** Terminal width in columns, when known. */
  columns?: number;
  /** Test seams: how long a hook waits for stdin, and for one model call. */
  stdinTimeoutMs?: number;
  modelTimeoutMs?: number;
}

export function realIo(): Io {
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    readStdin: () => Bun.stdin.text(),
    env: process.env,
    cwd: process.cwd(),
    outIsTTY: Boolean(process.stdout.isTTY),
    errIsTTY: Boolean(process.stderr.isTTY),
    columns: process.stdout.columns,
  };
}

export const USAGE = `offscript: did your coding agent do what you asked, only what you asked, and did it tell you the truth?

Usage
  offscript review [session-id-prefix]   review the latest session in this repo (or the one named)
    --repo <path>     repo to review (default: current directory)
    --no-llm          offline heuristic ledger, no Claude call
    --full            print every request, claim and flag, not just problems
    --json            machine output (schemaVersion 1)
    --md <file>       write the markdown report here (default: .offscript/reports/<date>-<id>.md)
    --hook            read Claude Code hook JSON from stdin, review that session, print one line
    --fail-on <lvl>   exit 1 when: never (default) | problems | any (for CI)
  offscript list                         sessions for this repo: id, date, prompts, edits
    --repo <path>  --limit <n>  --json
  offscript hook install [--project|--user]   add a SessionEnd hook to Claude Code settings (merge, never overwrite)

Exit codes: 0 ok, 1 problems found (with --fail-on), 2 usage error, 3 no session found, 4 unexpected failure.
`;

class UsageError extends Error {}

const OPTIONS = {
  repo: { type: "string" },
  "no-llm": { type: "boolean" },
  full: { type: "boolean" },
  json: { type: "boolean" },
  md: { type: "string" },
  hook: { type: "boolean" },
  "fail-on": { type: "string" },
  limit: { type: "string" },
  project: { type: "boolean" },
  user: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export async function run(argv: string[], io: Io = realIo()): Promise<number> {
  if (io.env.OFFSCRIPT_INNER === "1") return EXIT.ok; // never run inside our own judge call
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    io.err(`offscript: ${(e as Error).message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(USAGE);
    return EXIT.ok;
  }
  const [cmd, sub, ...extra] = positionals;
  try {
    if (cmd === "review" && extra.length === 0) return await review(values, sub, io);
    if (cmd === "list" && sub === undefined) return await list(values, io);
    if (cmd === "hook" && sub === "install" && extra.length === 0) return await hookInstall(values, io);
    throw new UsageError(cmd ? `unknown command: ${positionals.join(" ")}` : "missing command");
  } catch (e) {
    if (!(e instanceof UsageError)) {
      // No stack trace and never exit 1 here: 1 means "problems found", which scripts act on.
      io.err(`offscript: unexpected failure: ${(e as Error).message}\n`);
      return EXIT.failed;
    }
    io.err(`offscript: ${e.message}\n\n${USAGE}`);
    return EXIT.usage;
  }
}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function failOn(values: Values): "never" | "problems" | "any" {
  const v = values["fail-on"] ?? "never";
  if (v !== "never" && v !== "problems" && v !== "any") throw new UsageError(`--fail-on must be never, problems or any (got "${v}")`);
  return v;
}

/** Hook input, but never forever: a hook that waits on an open stdin would hang the end of a session. */
function readStdinBounded(io: Io): Promise<string> {
  return new Promise((resolveText, reject) => {
    const timer = setTimeout(() => reject(new Error("no hook input on stdin")), io.stdinTimeoutMs ?? HOOK_STDIN_TIMEOUT_MS);
    io.readStdin().then(
      (t) => {
        clearTimeout(timer);
        resolveText(t);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const shown = (path: string, cwd: string) => {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replace(/\\/g, "/") : path;
};

async function review(values: Values, prefix: string | undefined, io: Io): Promise<number> {
  const hook = values.hook === true;
  const level = failOn(values);
  // Pick the repo before anything slow: a hook says where it ran.
  let hookInput: ReturnType<typeof parseHookInput> | null = null;
  if (hook) {
    try {
      hookInput = parseHookInput(await readStdinBounded(io));
    } catch (e) {
      io.out(`${hookOutput(`offscript: ${(e as Error).message}`)}\n`);
      return EXIT.ok; // a hook must never block ending a session
    }
  }
  const say = (message: string) => io.out(`${hook ? hookOutput(message) : message}\n`);
  const progress = io.errIsTTY && !hook && !values.json && io.env.TERM !== "dumb";
  if (progress) io.err("offscript: reviewing...\r"); // the slow steps block the event loop, so this is a static line, not a spinner
  const clear = () => progress && io.err("\x1b[2K\r");

  try {
    const { openRepo, reviewSession } = await import("../../core/src/review.ts");
    const { parseSession } = await import("../../core/src/ingest/claude-code.ts");
    const { claudeAvailable } = await import("../../core/src/judge/claude-cli.ts");

    const repoArg = resolve(io.cwd, values.repo ?? hookInput?.cwd ?? ".");
    const ctx = openRepo(repoArg);
    if (!ctx) {
      clear();
      if (hook) say(`offscript: ${repoArg} is not a git repository`);
      else io.err(`offscript: not a git repository: ${repoArg}\n`);
      return hook ? EXIT.ok : EXIT.usage;
    }

    // Which session: the hook names it, a prefix picks it, otherwise the newest one that did any work.
    let session: ReturnType<typeof parseSession> | null = null;
    if (hookInput?.transcriptPath) {
      try {
        session = parseSession(hookInput.transcriptPath);
      } catch {
        session = null;
      }
    }
    const want = prefix ?? (hookInput?.transcriptPath ? undefined : (hookInput?.sessionId ?? undefined));
    if (!session && want !== undefined) {
      const hits = ctx.refs.filter((r) => r.id.startsWith(want));
      if (hits.length > 1) {
        clear();
        throw new UsageError(`"${want}" matches ${hits.length} sessions: ${hits.map((h) => h.id.slice(0, 12)).join(", ")}. Use more characters.`);
      }
      session = hits[0] ? ctx.getSession(hits[0].path) : null;
    } else if (!session && !hook) {
      for (const ref of ctx.refs) {
        const s = ctx.getSession(ref.path);
        if (s && s.prompts.length > 0 && s.edits.length > 0) {
          session = s;
          break;
        }
      }
    }
    if (!session) {
      clear();
      const msg = want !== undefined ? `no session starting with "${want}" in ${ctx.root}` : `no Claude Code session with edits found for ${ctx.root}`;
      if (hook) say(`offscript: ${msg}`);
      else io.err(`offscript: ${msg}. Looked in ~/.claude/projects (set CLAUDE_CONFIG_DIR if yours is elsewhere).\n`);
      return hook ? EXIT.ok : EXIT.noSession;
    }
    if (hook && session.edits.length === 0) {
      say(`offscript ${session.id.slice(0, 8)}: nothing to review (no edits)`);
      return EXIT.ok;
    }

    const modelTimeoutMs = hook ? (io.modelTimeoutMs ?? HOOK_MODEL_TIMEOUT_MS) : undefined;
    let mode: "heuristic" | "cached" = "cached";
    if (values["no-llm"]) mode = "heuristic";
    else if (!claudeAvailable()) {
      mode = "heuristic";
      if (!hook)
        io.err(
          "offscript: Claude Code CLI not found, using the offline heuristic ledger. Install/log in to Claude Code, set OFFSCRIPT_CLAUDE_BIN, or pass --no-llm.\n",
        );
    }
    let result = await reviewSession({ ctx, session, ledger: mode, modelTimeoutMs });
    if (mode === "cached" && result.report.ledger.error) {
      if (!hook) io.err(`offscript: the model call failed (${result.report.ledger.error.slice(0, 120)}), so this review uses the offline heuristic ledger.\n`);
      result = await reviewSession({ ctx, session, ledger: "heuristic" });
    }

    // The markdown report is always written; --md only moves it.
    const date = session.startedAt.slice(0, 10);
    const reportFile = values.md ? resolve(io.cwd, values.md) : join(ctx.root, ".offscript", "reports", `${date}-${session.id.slice(0, 8)}.md`);
    let reportPath: string | null = shown(reportFile, io.cwd);
    try {
      mkdirSync(dirname(reportFile), { recursive: true });
      writeFileSync(reportFile, result.markdown, "utf8");
    } catch (e) {
      reportPath = null;
      if (!hook) io.err(`offscript: could not write the report: ${(e as Error).message}\n`);
    }

    const summary = summarize(result);
    clear();
    if (hook) say(hookMessage(session.id, summary, reportPath));
    else if (values.json) io.out(`${JSON.stringify(toJson(result, reportPath, summary), null, 2)}\n`);
    else
      io.out(
        renderTerminal(
          result,
          { ...detectTerm(io.env, io.outIsTTY), full: values.full === true, reportPath, width: io.columns && io.columns > 0 ? io.columns : 100 },
          summary,
        ),
      );

    if (level === "never") return EXIT.ok;
    const bad = summary.problems.length + (level === "any" ? summary.notes.length : 0);
    return bad > 0 ? EXIT.problems : EXIT.ok;
  } catch (e) {
    clear();
    if (e instanceof UsageError) throw e;
    if (hook) {
      say(`offscript: review failed: ${(e as Error).message}`);
      return EXIT.ok;
    }
    throw e;
  }
}

async function list(values: Values, io: Io): Promise<number> {
  const limit = values.limit === undefined ? 20 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError(`--limit must be a positive whole number (got "${values.limit}")`);
  const { openRepo } = await import("../../core/src/review.ts");
  const ctx = openRepo(resolve(io.cwd, values.repo ?? "."));
  if (!ctx) {
    io.err(`offscript: not a git repository: ${resolve(io.cwd, values.repo ?? ".")}\n`);
    return EXIT.usage;
  }
  const rows: { id: string; startedAt: string; prompts: number; edits: number }[] = [];
  for (const ref of ctx.refs) {
    if (rows.length >= limit) break;
    const s = ctx.getSession(ref.path);
    if (s) rows.push({ id: s.id, startedAt: s.startedAt, prompts: s.prompts.length, edits: s.edits.length });
  }
  if (rows.length === 0) {
    io.err(`offscript: no Claude Code sessions found for ${ctx.root}. Looked in ~/.claude/projects (set CLAUDE_CONFIG_DIR if yours is elsewhere).\n`);
    return EXIT.noSession;
  }
  if (values.json) {
    io.out(`${JSON.stringify({ schemaVersion: 1, repo: ctx.root, sessions: rows }, null, 2)}\n`);
    return EXIT.ok;
  }
  io.out(`${"ID".padEnd(10)}${"DATE (UTC)".padEnd(18)}${"PROMPTS".padStart(7)}${"EDITS".padStart(7)}\n`);
  for (const r of rows)
    io.out(
      `${r.id.slice(0, 8).padEnd(10)}${r.startedAt.slice(0, 16).replace("T", " ").padEnd(18)}${String(r.prompts).padStart(7)}${String(r.edits).padStart(7)}\n`,
    );
  io.out("\nReview one with: offscript review <id>\n");
  return EXIT.ok;
}

async function hookInstall(values: Values, io: Io): Promise<number> {
  if (values.project && values.user) throw new UsageError("choose one of --project or --user");
  const scope = values.user ? "user" : "project";
  const repoDir = resolve(io.cwd, values.repo ?? ".");
  const path = settingsPath(scope, repoDir, io.env);
  const command = hookCommand(fileURLToPath(import.meta.url));
  try {
    const r = installHook(path, command);
    const shownPath = scope === "project" ? shown(r.path, io.cwd) : r.path;
    const verb = {
      created: "Created",
      added: "Added the SessionEnd hook to",
      updated: "Updated the SessionEnd hook in",
      unchanged: "The SessionEnd hook is already installed in",
    }[r.action];
    io.out(
      `${verb} ${shownPath}${r.action === "created" ? " with the SessionEnd hook" : ""}.\nEvery finished Claude Code session now gets a one-line review and a report in .offscript/reports/.\n`,
    );
    return EXIT.ok;
  } catch (e) {
    io.err(`offscript: ${(e as Error).message}\n`);
    return EXIT.usage;
  }
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2));
  process.exitCode = code;
  // A stdin read that never finished (hook with no input) would keep the process alive: leave once stdout is flushed.
  process.stdout.write("", () => process.exit(code));
}
