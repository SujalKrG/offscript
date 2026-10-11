// Deterministic facts about a diff. No model, no network. Never overridden by a model.
// Spike version uses line rules; v0.1 moves symbol facts to tree-sitter.

import type { DiffFile } from "./types.ts";

export interface Facts {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  added: string[];
  deleted: string[];
  renamed: { from: string; to: string }[];
  binary: string[];
  dependencyFiles: string[];
  sensitiveFiles: string[];
  testFiles: string[];
  removedSymbols: { file: string; symbol: string }[];
  testIntegrity: TestIntegrity;
}

export interface TestIntegrity {
  assertionsAdded: number;
  assertionsRemoved: number;
  skipsAdded: { file: string; line: string }[];
  testFilesDeleted: string[];
}

const DEP_FILE_RE =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|composer\.json|composer\.lock|Gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?)$/i;

export const DEFAULT_SENSITIVE: RegExp[] = [
  /(^|\/)\.github\//i,
  /(^|\/)\.gitlab-ci\.yml$/i,
  /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$/i,
  /(^|\/)(migrations?|prisma\/migrations)\//i,
  /(^|\/)schema\.prisma$/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)(auth|authentication|security|payments?|billing)(\/|\.)/i,
  /(^|\/)(infra|terraform|k8s|helm|deploy)\//i,
  /(^|\/)nginx[^/]*\.conf$/i,
];

export const TEST_FILE_RE =
  /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Test\.php$|Tests?\.cs$/i;

const ASSERT_RE = /\b(expect\s*\(|assert[A-Za-z]*\s*[.(]|should\.|\.should\b|t\.(?:Error|Fatal|Fail)\w*\s*\(|\$this->assert\w*\s*\()/g;
const SKIP_RE =
  /\b(?:it|test|describe|context)\.(?:skip|only|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|\bt\.Skip\w*\s*\(|\bmarkTestSkipped\s*\(|@Disabled\b|@Ignore\b|\[Ignore\]/;

const SYMBOL_RES: RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*\(/,
  /^\s*public\s+(?:static\s+)?function\s+(\w+)\s*\(/,
  /^\s*pub\s+(?:async\s+)?fn\s+(\w+)/,
  /^\s*module\.exports\.(\w+)\s*=/,
];

function symbolOf(line: string): string | null {
  for (const re of SYMBOL_RES) {
    const m = re.exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

function count(re: RegExp, s: string): number {
  return (s.match(re) ?? []).length;
}

export function extractFacts(files: DiffFile[], sensitive: RegExp[] = DEFAULT_SENSITIVE): Facts {
  const facts: Facts = {
    filesChanged: files.length,
    linesAdded: 0,
    linesRemoved: 0,
    added: [],
    deleted: [],
    renamed: [],
    binary: [],
    dependencyFiles: [],
    sensitiveFiles: [],
    testFiles: [],
    removedSymbols: [],
    testIntegrity: { assertionsAdded: 0, assertionsRemoved: 0, skipsAdded: [], testFilesDeleted: [] },
  };

  const addedSymbols = new Set<string>();
  for (const f of files) for (const l of f.added) {
    const s = symbolOf(l.text);
    if (s) addedSymbols.add(s);
  }

  for (const f of files) {
    facts.linesAdded += f.added.length;
    facts.linesRemoved += f.removed.length;
    if (f.status === "added") facts.added.push(f.path);
    if (f.status === "deleted") facts.deleted.push(f.oldPath ?? f.path);
    if (f.status === "renamed") facts.renamed.push({ from: f.oldPath ?? "", to: f.path });
    if (f.binary) facts.binary.push(f.path);
    if (DEP_FILE_RE.test(f.path)) facts.dependencyFiles.push(f.path);
    if (sensitive.some((re) => re.test(f.path) || (f.oldPath ? re.test(f.oldPath) : false))) facts.sensitiveFiles.push(f.path);

    const isTest = TEST_FILE_RE.test(f.path) || (f.oldPath ? TEST_FILE_RE.test(f.oldPath) : false);
    if (isTest) {
      facts.testFiles.push(f.path);
      if (f.status === "deleted") facts.testIntegrity.testFilesDeleted.push(f.oldPath ?? f.path);
      for (const l of f.added) {
        facts.testIntegrity.assertionsAdded += count(ASSERT_RE, l.text);
        if (SKIP_RE.test(l.text)) facts.testIntegrity.skipsAdded.push({ file: f.path, line: l.text.trim().slice(0, 120) });
      }
      for (const l of f.removed) facts.testIntegrity.assertionsRemoved += count(ASSERT_RE, l.text);
    }

    for (const l of f.removed) {
      const s = symbolOf(l.text);
      if (s && !addedSymbols.has(s)) facts.removedSymbols.push({ file: f.oldPath ?? f.path, symbol: s });
    }
  }
  return facts;
}
