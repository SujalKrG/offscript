// Secret redaction. Runs on every piece of transcript text before it is stored,
// printed or sent to a model. Spike version: regex rules. v0.1 adds secretlint.

interface Rule {
  name: string;
  re: RegExp;
  // Replace the whole match, or only capture group 2 (the value) when keepPrefix is set.
  keepPrefix?: boolean;
}

const RULES: Rule[] = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai-key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { name: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "url-credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s]+)(@)/gi, keepPrefix: true },
  {
    name: "assignment",
    re: /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    keepPrefix: true,
  },
];

export interface RedactResult {
  text: string;
  count: number;
}

export function redact(input: string): RedactResult {
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    text = text.replace(rule.re, (...m: string[]) => {
      count++;
      if (rule.keepPrefix) {
        const prefix = m[1] ?? "";
        const suffix = rule.name === "url-credentials" ? (m[3] ?? "") : "";
        return `${prefix}[REDACTED:${rule.name}]${suffix}`;
      }
      return `[REDACTED:${rule.name}]`;
    });
  }
  return { text, count };
}
