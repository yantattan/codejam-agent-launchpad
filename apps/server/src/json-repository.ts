import { HttpError } from "./errors.js";
import type { AgentRepository, PersistedAgent } from "./repository.js";
import { JsonStore } from "./store.js";
import type { AgentRun, Message } from "./types.js";

const now = () => new Date().toISOString();

/** Object.assign would overwrite a field with `undefined`; patches use
 * `undefined` to mean "leave unchanged", so only defined keys are applied. */
function applyPatch<T extends object>(target: T, patch: Partial<T>): void {
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) target[key] = value;
  }
}

/**
 * Wraps the existing single-file JsonStore behind the AgentRepository
 * interface. Used for local/offline dev and for tests, where a real
 * Postgres project isn't needed or wanted. Agents/Messages/Runs written
 * here stay on this machine only.
 */
export class JsonAgentRepository implements AgentRepository {
  constructor(
    private readonly store: JsonStore,
    private readonly workspacePath: (agentId: string) => string,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async listAgents(ownerId: string): Promise<PersistedAgent[]> {
    return this.store.snapshot().agents.filter((agent) => agent.ownerId === ownerId);
  }

  async getAgent(id: string, ownerId: string): Promise<PersistedAgent | null> {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    return agent && agent.ownerId === ownerId ? agent : null;
  }

  async insertAgent(agent: PersistedAgent): Promise<void> {
    await this.store.mutate((database) => {
      database.agents.push({ ...agent, workspacePath: this.workspacePath(agent.id) });
    });
  }

  async updateAgent(
    id: string,
    ownerId: string,
    patch: Partial<PersistedAgent>,
  ): Promise<PersistedAgent | null> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent || agent.ownerId !== ownerId) return null;
      applyPatch(agent, patch);
      return structuredClone(agent);
    });
  }

  async deleteAgent(id: string, ownerId: string): Promise<PersistedAgent | null> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent || agent.ownerId !== ownerId) return null;
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      return agent;
    });
  }

  async listMessages(agentId: string): Promise<Message[]> {
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async insertMessage(message: Message): Promise<void> {
    await this.store.mutate((database) => {
      database.messages.push(message);
    });
  }

  async listRuns(agentId: string): Promise<AgentRun[]> {
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getRun(id: string): Promise<AgentRun | null> {
    return this.store.snapshot().runs.find((item) => item.id === id) ?? null;
  }

  async insertRun(run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      database.runs.push(run);
    });
  }

  async updateRun(id: string, patch: Partial<AgentRun>): Promise<AgentRun | null> {
    return this.store.mutate((database) => {
      const run = database.runs.find((item) => item.id === id);
      if (!run) return null;
      applyPatch(run, patch);
      return structuredClone(run);
    });
  }

  async beginRun(agentId: string, ownerId: string): Promise<PersistedAgent | null> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent || agent.ownerId !== ownerId) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (agent.status === "busy") {
        // A follow-up message while a proposal is awaiting confirmation is
        // a refinement of that same proposal, not a conflicting new task —
        // everything else still counts as "already running".
        const latest = database.runs
          .filter((item) => item.agentId === agentId)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        if (latest?.status !== "pending_confirmation") {
          throw new HttpError(409, "This Agent is already running");
        }
      }
      const snapshot = structuredClone(agent);
      agent.status = "busy";
      agent.lastError = null;
      agent.updatedAt = now();
      return snapshot;
    });
  }

  async resetStaleExecutionState(): Promise<void> {
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running" || run.status === "pending_confirmation") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }
}
