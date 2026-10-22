// Terminal view: short by default (verdict plus one line of evidence per problem), full detail behind --full.
// Pure function of its inputs, so it is snapshot-testable.

import type { ReviewResult } from "../../core/src/review.ts";
import { type Mark, type Problem, type Summary, summarize } from "./summary.ts";

export interface RenderOptions {
  color: boolean;
  unicode: boolean;
  full: boolean;
  /** Path to show on the "Full report" line, or null when no report was written. */
  reportPath: string | null;
  maxProblems?: number;
  width?: number;
}

export interface TermCaps {
  color: boolean;
  unicode: boolean;
}

/** Colour and Unicode only on a real terminal: piped output is plain ASCII and stable. NO_COLOR turns both off. */
export function detectTerm(env: NodeJS.ProcessEnv, isTTY: boolean, platform: string = process.platform): TermCaps {
  const noColor = (env.NO_COLOR ?? "") !== "";
  if (!isTTY || noColor || env.TERM === "dumb") return { color: false, unicode: false };
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  // On Windows locale variables say nothing about the console: Windows Terminal, VS Code and ConEmu are UTF-8, legacy conhost may not be.
  const utf8 = platform === "win32" ? Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON") : /utf-?8/i.test(locale);
  return { color: true, unicode: utf8 };
}

const GLYPHS = {
  unicode: { ok: "✔", bad: "✘", partly: "◐", warn: "~", gap: "?" },
  ascii: { ok: "[ok]", bad: "[x]", partly: "[/]", warn: "[~]", gap: "[?]" },
};
type Kind = "ok" | Mark;

const ANSI = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m" };
const COLOR_OF: Record<Kind, string> = { ok: ANSI.green, bad: ANSI.red, partly: ANSI.yellow, warn: ANSI.yellow, gap: ANSI.yellow };

// Transcript text is untrusted: an escape sequence in a prompt, claim or file name must not drive the terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const flat = (s: string) => s.replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();

/** Cut to `max` characters on a word boundary with "...". A single word longer than the room is cut mid-word. */
function fit(s: string, max: number): string {
  const one = flat(s);
  if (one.length <= max) return one;
  const room = Math.max(0, max - 3);
  const cut = one.slice(0, room);
  const at = one[room] === " " ? room : cut.lastIndexOf(" ");
  const head = at >= Math.floor(room / 2) ? cut.slice(0, at) : cut;
  return `${head.trimEnd()}...`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function renderTerminal(r: ReviewResult, opts: RenderOptions, summary: Summary = summarize(r)): string {
  const g = opts.unicode ? GLYPHS.unicode : GLYPHS.ascii;
  const paint = (kind: Kind, s: string) => (opts.color ? `${COLOR_OF[kind]}${s}${ANSI.reset}` : s);
  const bold = (s: string) => (opts.color ? `${ANSI.bold}${s}${ANSI.reset}` : s);
  const dim = (s: string) => (opts.color ? `${ANSI.dim}${s}${ANSI.reset}` : s);
  const mark = (kind: Kind) => paint(kind, g[kind]);
  const width = Math.max(60, opts.width ?? 100);
  const max = opts.maxProblems ?? 8;
  const s = r.session;
  const sm = summary;

  const L: string[] = [];
  L.push(
    `${bold("offscript")}  ${s.id.slice(0, 8)}  ${s.startedAt.slice(0, 16).replace("T", " ")}  ${plural(sm.requests, "request")}, ${plural(s.edits.length, "edit")}${
      sm.tracedPct === null ? "" : `, ${sm.tracedPct}% traced`
    }`,
  );
  L.push("");

  const row = (label: string, parts: string[]) => L.push(`  ${label.padEnd(22)}${parts.join("  ")}`);
  const did: string[] = [];
  if (sm.did.done) did.push(`${mark("ok")} ${sm.did.done} done`);
  if (sm.did.partly) did.push(`${mark("partly")} ${sm.did.partly} partly`);
  if (sm.did.notDone) did.push(`${mark("bad")} ${sm.did.notDone} not done`);
  if (sm.did.unclear) did.push(`${mark("gap")} ${sm.did.unclear} unclear`);
  row("Did what you asked", did.length ? did : [dim("no requests found")]);

  const only: string[] = [];
  if (!sm.scope.checked) only.push(dim("no change found to check"));
  else {
    if (sm.scope.againstInstruction) only.push(`${mark("bad")} ${sm.scope.againstInstruction} against your instructions`);
    if (sm.scope.unexplained) only.push(`${mark("warn")} ${plural(sm.scope.unexplained, "unexplained file")}`);
    if (!only.length) only.push(`${mark("ok")} no unexplained files`);
  }
  row("Only what you asked", only);

  const t = sm.truth;
  const truth: string[] = [];
  if (t.contradicted) truth.push(`${mark("bad")} ${t.contradicted} contradicted`);
  if (t.stale) truth.push(`${mark("warn")} ${t.stale} stale`);
  if (t.overstated) truth.push(`${mark("warn")} ${t.overstated} overstated`);
  if (t.unsupported) truth.push(`${mark("warn")} ${t.unsupported} unsupported`);
  if (t.silentGaps) truth.push(`${mark("gap")} ${plural(t.silentGaps, "silent gap")}`);
  if (!truth.length) truth.push(t.verified ? `${mark("ok")} ${plural(t.verified, "claim")} verified` : dim("no checkable claims"));
  row("Told the truth", truth);
  L.push("");

  const line = (p: Problem) => {
    // The quote gets about 40% of the line, the evidence the rest.
    const quoteMax = Math.max(20, Math.floor(width * 0.4));
    const label = p.id ? `${p.id} "${fit(p.text, quoteMax)}"` : p.kind === "file" || p.kind === "review" ? flat(p.text) : `"${fit(p.text, quoteMax)}"`;
    const head = `  ${g[p.mark]} ${label}  `;
    const detail = opts.full ? flat(p.detail) : fit(p.detail, Math.max(20, width - head.length));
    return `  ${mark(p.mark)} ${label}  ${detail}`;
  };
  if (sm.problems.length) {
    L.push(`  ${bold("Problems")}`);
    const shown = opts.full ? sm.problems : sm.problems.slice(0, max);
    for (const p of shown) L.push(line(p));
    if (sm.problems.length > shown.length) L.push(dim(`  +${sm.problems.length - shown.length} more (--full)`));
  } else {
    L.push(`  ${mark("ok")} No problems found.`);
  }

  if (opts.full) {
    if (r.verdicts?.verdicts.length) {
      L.push("", `  ${bold("Every request")}`);
      for (const v of r.verdicts.verdicts) {
        const kind: Kind = ["done", "answered", "kept"].includes(v.verdict)
          ? "ok"
          : v.verdict === "partly done"
            ? "partly"
            : ["not done", "failed", "violated", "not in change"].includes(v.verdict)
              ? "bad"
              : "gap";
        L.push(`  ${mark(kind)} ${v.id} "${fit(v.text, 36)}"  ${v.verdict}: ${flat(v.why)}`);
      }
    }
    if (r.claims?.claims.length) {
      L.push("", `  ${bold("Every claim")}`);
      for (const c of r.claims.claims) {
        const kind: Kind = c.verdict === "verified" ? "ok" : c.verdict === "contradicted" ? "bad" : c.verdict === "unverified" ? "gap" : "warn";
        L.push(`  ${mark(kind)} "${fit(c.sentence, 36)}"  ${c.verdict}: ${flat(c.evidence)}`);
      }
    }
    const flagged = [...r.flags].filter(([, f]) => f.length);
    if (flagged.length) {
      L.push("", `  ${bold("Flagged files")}`);
      for (const [path, flags] of flagged) L.push(`  ${flat(path)}  ${flags.join(", ")}`);
    }
    if (sm.notes.length) {
      L.push("", `  ${bold("Worth a look")}`);
      for (const p of sm.notes) L.push(line(p));
    }
  }

  if (opts.reportPath) L.push("", `  ${bold("Full report")}  ${opts.reportPath}`);
  return `${L.join("\n")}\n`;
}
