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

export type ScanSeverity = "info" | "suspicious" | "malicious";

export interface ScanFinding {
  tier: "static" | "semantic";
  severity: ScanSeverity;
  technique: string;
  source: "prompt" | "workspace-file";
  path?: string;
  excerpt: string;
  detail: string;
}

export interface ScanVerdict {
  blocked: boolean;
  findings: ScanFinding[];
  scannedAt: string;
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
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export type FileChangeKind = "created" | "modified" | "deleted";

export interface DiffLine {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  isBinary: boolean;
  sizeBefore: number | null;
  sizeAfter: number | null;
  diff?: DiffLine[];
  contentAfter?: string;
  contentBefore?: string;
}

export interface PendingChangeSet {
  files: FileChange[];
  truncated: boolean;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
  scan: ScanVerdict | null;
  pendingChanges: PendingChangeSet | null;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
