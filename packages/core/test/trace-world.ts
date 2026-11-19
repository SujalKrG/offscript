// Test world for Agent Trace export: a throwaway git repo plus Claude Code style transcripts that edit it.
// Everything is offline and deterministic. The caller decides what the "agent" wrote and what a "human" wrote.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionChange } from "../src/git.ts";
import { openRepo } from "../src/review.ts";
import { buildTraceRecords, type TraceRecord, type TraceSummary } from "../src/trace.ts";

const made: string[] = [];
process.on("exit", () => {
  for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

export class World {
  readonly base = realpathSync.native(mkdtempSync(join(tmpdir(), "offscript-trace-")));
  readonly repo = join(this.base, "proj");
  readonly projects = join(this.base, "claude", "projects");
  private n = 0;

  constructor() {
    made.push(this.base);
    mkdirSync(this.repo, { recursive: true });
    mkdirSync(this.projects, { recursive: true });
    this.git("init", "-q");
  }

  git(...args: string[]): string {
    const argv = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args];
    // A git that never ran (spawn error, killed by a signal) has no exit status and no stderr: retry that, never a real git failure.
    let r = spawnSync("git", argv, { cwd: this.repo, encoding: "utf8" });
    for (let i = 0; i < 3 && r.status === null; i++) r = spawnSync("git", argv, { cwd: this.repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: status ${r.status} signal ${r.signal} ${r.error?.message ?? ""} ${r.stderr}`);
    return r.stdout;
  }

  write(rel: string, lines: string[]) {
    const p = join(this.repo, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines.length ? `${lines.join("\n")}\n` : "");
  }

  read(rel: string): string[] {
    const t = readFileSync(join(this.repo, rel), "utf8");
    return t === "" ? [] : t.replace(/\n$/, "").split("\n");
  }

  remove(rel: string) {
    rmSync(join(this.repo, rel));
  }

  move(from: string, to: string) {
    mkdirSync(dirname(join(this.repo, to)), { recursive: true });
    renameSync(join(this.repo, from), join(this.repo, to));
  }

  /** Commit everything. With amend, fold it into the last commit. Returns the new HEAD sha. */
  commit(message = "work", amend = false): string {
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", ...(amend ? ["--amend", "--no-edit"] : []), "-m", message);
    return this.git("rev-parse", "HEAD").trim();
  }

  /** File content in a commit, as lines. */
  show(sha: string, rel: string): string[] {
    const t = this.git("show", `${sha}:${rel}`);
    return t === "" ? [] : t.replace(/\n$/, "").split("\n");
  }

  session(id: string, opts: { version?: string | null } = {}): SessionBuilder {
    return new SessionBuilder(this, id, opts.version === undefined ? "2.1.300" : opts.version, this.n++);
  }

  /** Records for one session, built through the same path the CLI uses. */
  export(sessionId: string, now = new Date("2026-11-18T00:00:00Z")): { records: TraceRecord[]; summary: TraceSummary } {
    const ctx = openRepo(this.repo, this.projects)!;
    const ref = ctx.refs.find((r) => r.id === sessionId)!;
    const session = ctx.getSession(ref.path)!;
    const change = sessionChange(ctx.root, session)!;
    return buildTraceRecords({ repoRoot: ctx.root, session, change, others: ctx.othersFor(session), generatorVersion: "test", now });
  }
}

let uuidN = 0;
const uuid = () => `11111111-0000-4000-8000-${String(++uuidN).padStart(12, "0")}`;

export class SessionBuilder {
  private recs: unknown[] = [];
  private t: number;
  private toolN = 0;
  private prompts = 0;

  constructor(
    private w: World,
    readonly id: string,
    private version: string | null,
    order: number,
  ) {
    this.t = Date.now() - 120_000 + order * 50;
  }

  private common() {
    this.t += 100;
    return {
      sessionId: this.id,
      cwd: this.w.repo,
      gitBranch: "main",
      ...(this.version ? { version: this.version } : {}),
      uuid: uuid(),
      timestamp: new Date(this.t).toISOString(),
    };
  }

  prompt(text: string): this {
    this.prompts++;
    this.recs.push({ ...this.common(), type: "user", origin: { kind: "human" }, message: { role: "user", content: [{ type: "text", text }] } });
    return this;
  }

  /** The agent wrote a whole new file with the Write tool. */
  create(rel: string, lines: string[], model?: string): this {
    const filePath = join(this.w.repo, rel);
    return this.tool(
      "Write",
      { file_path: filePath, content: "" },
      { type: "create", filePath, content: `${lines.join("\n")}\n`, structuredPatch: [], originalFile: null },
      model,
    );
  }

  /** The agent added (and optionally removed) lines with the Edit tool. */
  edit(rel: string, added: string[], removed: string[] = [], model?: string): this {
    const filePath = join(this.w.repo, rel);
    const lines = [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)];
    return this.tool(
      "Edit",
      { file_path: filePath, old_string: "x", new_string: "y" },
      { filePath, structuredPatch: [{ oldStart: 1, oldLines: removed.length, newStart: 1, newLines: added.length, lines }] },
      model,
    );
  }

  /** An assistant text reply (the closing reply when it is the last one after a prompt). */
  say(text: string): this {
    this.recs.push({ ...this.common(), type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    return this;
  }

  /** A Bash call and its result, ordered in time with the edits. A failed run is a tool_result with is_error. */
  run(command: string, o: { failed?: boolean; output?: string } = {}): this {
    const id = `tool-${this.id}-${++this.toolN}`;
    this.recs.push({
      ...this.common(),
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
    });
    this.recs.push({
      ...this.common(),
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: o.output ?? "ok", is_error: o.failed === true }] },
      toolUseResult: { stdout: o.output ?? "", stderr: "" },
    });
    return this;
  }

  private tool(name: string, input: unknown, result: unknown, model?: string): this {
    const id = `tool-${this.id}-${++this.toolN}`;
    this.recs.push({
      ...this.common(),
      type: "assistant",
      message: { role: "assistant", ...(model ? { model } : {}), content: [{ type: "tool_use", id, name, input }] },
    });
    this.recs.push({
      ...this.common(),
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] },
      toolUseResult: result,
    });
    return this;
  }

  /** Write the transcript. The session's last timestamp is "now" so commits made around now fall in its window. */
  done(): this {
    if (this.prompts === 0) this.prompt("do the work");
    const dir = join(this.w.projects, this.w.repo.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${this.id}.jsonl`), `${this.recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
    return this;
  }
}

/** Expand exported ranges into "path:line" keys per (conversation order) for easy comparison. */
export function linesOf(record: TraceRecord): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const f of record.files) {
    const s = new Set<number>();
    for (const c of f.conversations) for (const r of c.ranges) for (let n = r.start_line; n <= r.end_line; n++) s.add(n);
    out.set(f.path, s);
  }
  return out;
}
