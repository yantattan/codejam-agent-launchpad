export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "pending_confirmation"
  | "discarded";
export type MessageRole = "user" | "assistant";

export type ScanTargetSource = "prompt" | "workspace-file";
export type ScanTier = "static" | "semantic";
export type ScanSeverity = "info" | "suspicious" | "malicious";

export interface ScanFinding {
  tier: ScanTier;
  severity: ScanSeverity;
  /** e.g. "fake-system-message", "zero-width-char", "encoded-instruction",
   * "semantic-out-of-scope-directive" */
  technique: string;
  source: ScanTargetSource;
  path?: string;
  excerpt: string;
  detail: string;
}

export interface ScanVerdict {
  blocked: boolean;
  findings: ScanFinding[];
  scannedAt: string;
  /** True if the scan hit a size/count cap and skipped some content. */
  truncated?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export type FileChangeKind = "created" | "modified" | "deleted";

export interface DiffLine {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface FileChange {
  /** Relative to the Agent's workspace root, forward-slash separated. */
  path: string;
  kind: FileChangeKind;
  isBinary: boolean;
  /** Bytes, null if the file did not exist before this run. */
  sizeBefore: number | null;
  /** Bytes, null if the file was deleted. */
  sizeAfter: number | null;
  /** Line-by-line diff, only present for modified text files. */
  diff?: DiffLine[];
  /** Full new content, only present for created text files. */
  contentAfter?: string;
  /** Full old content, only present for deleted text files. */
  contentBefore?: string;
}

export interface PendingChangeSet {
  files: FileChange[];
  /** True if the change set hit a size/count cap and some files were
   * reported without diff/content detail. */
  truncated: boolean;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  scan: ScanVerdict | null;
  pendingChanges: PendingChangeSet | null;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
