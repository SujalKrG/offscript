// Scope: was each file the agent changed part of what you asked for?
//
// Deterministic, no model, no network. Same shape as tools that untangle changes
// (Herzig & Zeller's "confidence voters") and agent scope checkers (unasked):
//   1. anchors   files your request points at (named, or words from your prompts in the path)
//   2. related   one hop from an anchor: its test, an import either way, a sibling in a small folder
//   3. derived   lockfiles, generated code, snapshots, housekeeping files
//   4. drift     everything else the agent touched
// Plus one check the others lack: files whose name appears in an instruction NOT to touch them.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { DEFAULT_SENSITIVE } from "./facts.ts";
import type { FileProvenance, Provenance } from "./provenance.ts";

export type ScopeKind = "anchor" | "related" | "derived" | "scratch" | "drift";

export interface FileScope {
  kind: ScopeKind;
  reason: string; // short, human: "named in prompt 3", "test for src/cart.ts", "imported by api.ts"
  againstInstruction: { prompt: number; text: string } | null; // you said not to touch it, and it changed
}

export interface ScopeInput {
  provenance: Provenance;
  prompts: { index: number; text: string }[];
  /** Extra request text, e.g. the intent ledger's task lines, matched like prompts (as prompt 0). */
  extraText?: string[];
  /** Worktree roots, to read file contents for import edges. */
  roots?: string[];
  /** Every tracked path in the repo (git ls-files), to tell rare, telling words from ones that are everywhere. */
  repoPaths?: string[];
}

/**
 * Words in more than 5% of the repo's paths (and at least 20 of them) say little about which file you meant:
 * in an app with a driver and a rider app, "driver" is in a quarter of all paths. Such words do not anchor
 * a file on their own. Files you name directly are unaffected.
 */
export function commonPathWords(repoPaths: string[], share = 0.05, min = 20): Set<string> {
  const df = new Map<string, number>();
  for (const p of repoPaths) for (const w of pathWords(p)) df.set(w, (df.get(w) ?? 0) + 1);
  const limit = Math.max(min, repoPaths.length * share);
  return new Set([...df].filter(([, n]) => n > limit).map(([w]) => w));
}

/** Lockfiles, generated output and repo housekeeping: changed as a side effect, never scope drift by themselves. */
export const DERIVED_RE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|bun\.lock|poetry\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|composer\.lock|Gemfile\.lock|\.gitignore|\.gitattributes|\.dockerignore|\.prettierignore|\.eslintignore|\.editorconfig|tsconfig\.tsbuildinfo|next-env\.d\.ts)$|(^|\/)(dist|build|out|coverage|__generated__|generated|\.next|\.expo)\/|\.(snap|generated\.[a-z]+|min\.(js|css)|map)$|(^|\/)__snapshots__\//i;

const TEST_RE = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Test\.php$|Tests?\.cs$/i;

/** Path words too common to say anything about intent. */
const GENERIC = new Set(
  (
    "src lib libs app apps api apis packages package core common shared utils util helpers helper index main mod module modules " +
    "components component features feature types type test tests spec specs unit integration e2e mocks mock fixtures fixture " +
    "public assets static styles style config configs scripts script docs doc readme server client web mobile frontend backend " +
    "service services controller controllers routes route model models schema schemas store stores hooks hook screens screen " +
    "page pages views view layout layouts tsx jsx json yaml yml test.ts spec.ts constants constant data file files new old"
  ).split(" "),
);

/** Verbs that change a file. "Break" and "work" are not here: "without breaking them" and "keep X working" are goals, not "leave it alone". */
const TOUCH_VERB =
  "touch(?:ing)?|chang(?:e|ing)|modif(?:y|ying)|edit(?:ing)?|rewrit(?:e|ing)|refactor(?:ing)?|delete|deleting|remov(?:e|ing)|renam(?:e|ing)|mov(?:e|ing)|alter(?:ing)?|overwrit(?:e|ing)|replac(?:e|ing)";

/** A real prohibition ("don't touch auth", "leave payments alone", "keep the schema as is"), not any sentence with "not" in it. */
const NEGATION_RE = new RegExp(
  `\\b(?:(?:don'?t|dont|do not|never|shouldn'?t|should not|must not|mustn'?t|avoid|without)\\b[^.!?\\n]{0,40}?\\b(?:${TOUCH_VERB})|leave\\b[^.!?\\n]{0,40}?\\balone|keep\\b[^.!?\\n]{0,40}?\\b(?:as is|untouched|intact|unchanged))\\b`,
  "i",
);

/** True when the text tells the agent to leave something alone, so a changed file can break it. */
export function isFileConstraint(text: string): boolean {
  return NEGATION_RE.test(text) || /\b(?:do not|don'?t) (?:add|create)\b/i.test(text);
}

/** Agent scratch space: throwaway helper scripts and notes, reported once as a group, not as drift per file. */
export const SCRATCH_RE = /(^|\/)(\.scratch|scratch|scratchpad|\.tmp|tmp|\.claude-tmp)\//i;

const isSensitive = (p: string) => DEFAULT_SENSITIVE.some((re) => re.test(p));

/** Words of a path: segments and the stem, split on case, dashes, underscores and dots; light plural folding. */
export function pathWords(path: string): string[] {
  const parts = path
    .replace(/\.[^./]+$/, "")
    .split(/[/\\._\-\s[\]()]+/)
    .flatMap((p) => p.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w));
  return [...new Set(parts.map(fold))];
}

function fold(w: string): string {
  if (w.length > 5 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("es") && /(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function textWords(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4)
      .map(fold),
  );
}

/** "src/cart.test.ts" -> "src/cart"; "tests/unit/cart.test.ts" -> "cart"; "foo_test.go" -> "foo". */
function testSubjectStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base
    .replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, "")
    .replace(/_test\.(go|py)$/i, "")
    .replace(/^test_/i, "")
    .replace(/(Tests?|Test)\.(php|cs)$/, "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
}

function stemOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "").toLowerCase();
}

const IMPORT_RE = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*|import\s+)['"]([^'"]+)['"]/g;
const EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/** Repo-relative paths this file imports, resolved against the set of changed files (relative and "@/"/"~/" aliases). */
function importsOf(path: string, content: string, changed: string[]): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(IMPORT_RE)) {
    const spec = m[1]!;
    let candidates: string[] = [];
    if (spec.startsWith(".")) {
      const base = posix.normalize(posix.join(posix.dirname(path), spec)).replace(/\.(js|mjs|cjs)$/, "");
      candidates = [base, ...EXT.map((e) => base + e), ...EXT.map((e) => `${base}/index${e}`)];
      for (const c of candidates) if (changed.includes(c)) out.add(c);
    } else if (/^[@~#]\//.test(spec)) {
      // Path alias: match by suffix, "@/lib/otp" -> any changed ".../lib/otp.ts" in the same top-level package.
      const tail = spec.slice(2).replace(/\.(js|mjs|cjs)$/, "");
      const pkg = path.split("/").slice(0, 2).join("/");
      for (const c of changed) {
        const noExt = c.replace(/\.[^./]+$/, "").replace(/\/index$/, "");
        if (noExt.endsWith(`/${tail}`) && c.startsWith(pkg)) out.add(c);
      }
    }
  }
  out.delete(path);
  return [...out];
}

function readFileFromRoots(rel: string, roots: string[]): string | null {
  for (const r of roots) {
    const p = join(r, rel);
    try {
      if (existsSync(p) && statSync(p).size < 2 * 1024 * 1024) return readFileSync(p, "utf8");
    } catch {
      // unreadable: fall through
    }
  }
  return null;
}

export function classifyScope(input: ScopeInput): Map<string, FileScope> {
  const files = input.provenance.files;
  const changed = files.map((f) => f.path);
  const out = new Map<string, FileScope>();

  // Sentences that tell the agent NOT to touch something, and sentences that ask for something.
  const negative: { prompt: number; text: string; words: Set<string> }[] = [];
  const positive: { prompt: number; words: Set<string> }[] = [];
  const sources = [...input.prompts, ...(input.extraText ?? []).map((t) => ({ index: 0, text: t }))];
  for (const p of sources) {
    for (const sentence of p.text.split(/(?<=[.!?\n])\s+|\s+(?:but|and|also)\s+(?=(?:don'?t|do not|never|leave|avoid)\b)/i)) {
      if (NEGATION_RE.test(sentence)) negative.push({ prompt: p.index, text: sentence.trim().slice(0, 120), words: textWords(sentence) });
      else positive.push({ prompt: p.index, words: textWords(sentence) });
    }
  }

  // 1. anchors
  const common = commonPathWords(input.repoPaths ?? []);
  const anchorReason = new Map<string, string>();
  for (const f of files) {
    if (f.inPrompts) {
      anchorReason.set(f.path, "named in your prompts");
      continue;
    }
    const words = pathWords(f.path).filter((w) => !common.has(w));
    for (const s of positive) {
      const hit = words.find((w) => s.words.has(w));
      if (hit) {
        anchorReason.set(f.path, s.prompt ? `"${hit}" in prompt ${s.prompt}` : `"${hit}" in the intent ledger`);
        break;
      }
    }
  }

  // 2. related, one hop from an anchor or a file the agent disclosed
  const content = new Map<string, string>();
  const textOf = (f: FileProvenance) => {
    if (!content.has(f.path)) content.set(f.path, readFileFromRoots(f.path, input.roots ?? []) ?? "");
    return content.get(f.path)!;
  };
  const seeds = files.filter((f) => anchorReason.has(f.path) || f.inAgentText).map((f) => f.path);
  const seedSet = new Set(seeds);
  const imports = new Map<string, string[]>();
  for (const f of files) if (/\.[cm]?[jt]sx?$/.test(f.path)) imports.set(f.path, importsOf(f.path, textOf(f), changed));
  const dirCount = new Map<string, number>();
  for (const p of changed) dirCount.set(dirname(p), (dirCount.get(dirname(p)) ?? 0) + 1);

  const relatedReason = new Map<string, string>();
  for (const f of files) {
    if (seedSet.has(f.path)) continue;
    // its test, or the code its test covers
    if (TEST_RE.test(f.path)) {
      const subject = testSubjectStem(f.path);
      const covers = changed.find((c) => c !== f.path && !TEST_RE.test(c) && stemOf(c) === subject);
      if (covers) {
        relatedReason.set(f.path, `test for ${covers}`);
        continue;
      }
    }
    // imports: one hop either way
    const out1 = (imports.get(f.path) ?? []).find((p) => seedSet.has(p));
    if (out1) {
      relatedReason.set(f.path, `imports ${out1}`);
      continue;
    }
    const in1 = seeds.find((s) => (imports.get(s) ?? []).includes(f.path));
    if (in1) {
      relatedReason.set(f.path, `imported by ${in1}`);
      continue;
    }
    // sibling of a seed in a small folder (12 or fewer changed files there, like unasked)
    const sib = seeds.find((s) => dirname(s) === dirname(f.path));
    if (sib && !isSensitive(f.path) && (dirCount.get(dirname(f.path)) ?? 0) <= 12) {
      relatedReason.set(f.path, `same folder as ${sib}`);
      continue;
    }
    // a test with no matching subject still exercises changed code in the same package
    if (TEST_RE.test(f.path)) {
      const pkg = f.path.split("/").slice(0, 2).join("/");
      const sameArea = seeds.find((s) => s.startsWith(`${pkg}/`) || s.split("/")[0] === f.path.split("/")[0]);
      if (sameArea) relatedReason.set(f.path, `test in the same area as ${sameArea}`);
    }
  }

  for (const f of files) {
    const words = pathWords(f.path);
    const neg = negative.find((n) => words.some((w) => n.words.has(w)));
    // Another request that anchors this file (a task in the ledger, a positive sentence) means the edit was asked for.
    const askedElsewhere = anchorReason.has(f.path) && !f.inPrompts;
    const againstInstruction = neg && f.touchedByAgent && !askedElsewhere ? { prompt: neg.prompt, text: neg.text } : null;
    let kind: ScopeKind;
    let reason: string;
    if (SCRATCH_RE.test(f.path) && !f.inPrompts) {
      kind = "scratch";
      reason = "agent scratch file";
    } else if (DERIVED_RE.test(f.path)) {
      // Side effects of other work, even when a word in the path matches your request.
      kind = "derived";
      reason = "lockfile, generated or housekeeping file";
    } else if (anchorReason.has(f.path) && !(neg && !f.inPrompts && negOnly(words, neg.words, positive))) {
      kind = "anchor";
      reason = anchorReason.get(f.path)!;
    } else if (relatedReason.has(f.path)) {
      kind = "related";
      reason = relatedReason.get(f.path)!;
    } else if (f.inAgentText) {
      kind = "related";
      reason = "the agent told you about it";
    } else {
      kind = "drift";
      reason = f.touchedByAgent ? "not asked for, not mentioned, not linked to anything asked for" : "changed outside this session's edits";
    }
    out.set(f.path, { kind, reason, againstInstruction });
  }
  return out;
}

/** True when the only prompt words that hit this path come from a "don't touch" sentence. */
function negOnly(pathW: string[], negWords: Set<string>, positive: { words: Set<string> }[]): boolean {
  const hitsNeg = pathW.some((w) => negWords.has(w));
  const hitsPos = positive.some((s) => pathW.some((w) => s.words.has(w)));
  return hitsNeg && !hitsPos;
}
