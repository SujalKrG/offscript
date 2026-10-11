// Normalised session model shared by every agent reader (Claude Code now, Codex later).

export interface HumanPrompt {
  index: number; // 1-based, in order
  uuid: string;
  timestamp: string;
  text: string; // redacted
}

export interface AssistantText {
  afterPrompt: number; // index of the human prompt this reply belongs to (0 = before any prompt)
  uuid: string;
  timestamp: string;
  text: string; // redacted
}

export interface FileEdit {
  seq: number; // global order of edits in the session
  afterPrompt: number;
  toolUseId: string;
  tool: string; // Edit, Write, MultiEdit, NotebookEdit
  filePath: string; // absolute, as recorded
  addedLines: string[]; // lines this edit introduced
  removedLines: string[]; // lines this edit removed
  kind: "create" | "update";
  failed: boolean;
  timestamp?: string; // when the tool call was made
  subagent?: string; // set when a subagent (Task tool) made the edit
}

export interface ShellRun {
  seq: number; // shares the counter with FileEdit so order can be compared
  afterPrompt: number;
  toolUseId: string;
  command: string; // redacted
  isTest: boolean;
  failed: boolean | null; // null when no result was recorded
  timestamp?: string;
  subagent?: string;
}

export interface Session {
  agent: "claude-code";
  id: string;
  path: string;
  cwd: string;
  gitBranch: string | null;
  cliVersion: string | null;
  startedAt: string;
  endedAt: string;
  prompts: HumanPrompt[];
  assistant: AssistantText[];
  edits: FileEdit[];
  shell: ShellRun[];
  compactions: number;
  unknownRecordTypes: Record<string, number>;
  redactions: number;
  subagentFiles: number; // subagent transcripts merged into this session
  /**
   * What changed in each tracked file between two of Claude Code's own backups
   * (~/.claude/file-history). Covers changes made any way during a turn: edit tools,
   * scripts run through Bash, subagents. Kept apart from `edits` because the exact
   * moment inside the turn is unknown.
   */
  turnDeltas: FileEdit[];
  backupFiles: number; // tracked files with at least two backups found on disk
  /** Each tracked file as it was before this session first touched it (Claude Code's first backup). */
  baselines: { filePath: string; backupPath: string | null }[]; // backupPath null: the file did not exist yet
  backupLinesUnexplained: number; // lines that changed between backups while the agent could not have written them
}

export interface DiffHunkLine {
  file: string; // repo-relative, posix
  newLineNo: number;
  text: string;
}

export interface DiffFile {
  path: string; // repo-relative, posix (new path)
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  added: DiffHunkLine[];
  removed: { file: string; oldLineNo: number; text: string }[];
  binary: boolean;
}

export interface Intent {
  id: string;
  text: string;
  kind: "task" | "constraint" | "preference";
  sourcePrompts: number[];
  quote: string;
  status: "active" | "superseded" | "cancelled";
  supersededBy: string | null;
}

export interface Claim {
  text: string;
  type: "tests_pass" | "implemented" | "fixed" | "other";
}

export interface IntentLedger {
  intents: Intent[];
  claims: Claim[];
  confidence: "high" | "medium" | "low";
  notes: string;
  backend: string;
  costUsd: number | null;
  error: string | null;
}
