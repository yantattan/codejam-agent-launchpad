import type { Agent, AgentRun, Message } from "./types.js";

/** Agent shape as persisted: `workspacePath` is machine-local, never stored. */
export type PersistedAgent = Omit<Agent, "workspacePath">;

export interface AgentRepository {
  initialize(): Promise<void>;

  listAgents(ownerId: string): Promise<PersistedAgent[]>;
  getAgent(id: string, ownerId: string): Promise<PersistedAgent | null>;
  insertAgent(agent: PersistedAgent): Promise<void>;
  updateAgent(
    id: string,
    ownerId: string,
    patch: Partial<PersistedAgent>,
  ): Promise<PersistedAgent | null>;
  deleteAgent(id: string, ownerId: string): Promise<PersistedAgent | null>;

  listMessages(agentId: string): Promise<Message[]>;
  insertMessage(message: Message): Promise<void>;

  listRuns(agentId: string): Promise<AgentRun[]>;
  getRun(id: string): Promise<AgentRun | null>;
  insertRun(run: AgentRun): Promise<void>;
  updateRun(id: string, patch: Partial<AgentRun>): Promise<AgentRun | null>;

  /**
   * Atomically admits one run: fails (returns null) unless the Agent exists,
   * is owned by ownerId, and is not stopped or already busy. On success the
   * Agent is marked busy and its pre-transition snapshot is returned.
   */
  beginRun(agentId: string, ownerId: string): Promise<PersistedAgent | null>;

  /** Called once at boot to clear state left over from an unclean shutdown. */
  resetStaleExecutionState(): Promise<void>;
}
