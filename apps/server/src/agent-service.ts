import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { AgentRepository, PersistedAgent } from "./repository.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly repository: AgentRepository,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.repository.initialize();
    await this.workspaces.initialize();
    await this.repository.resetStaleExecutionState();
  }

  private toPublicAgent(agent: PersistedAgent): Agent {
    return { ...agent, workspacePath: this.workspaces.workspacePath(agent.id) };
  }

  async listAgents(ownerId: string): Promise<Agent[]> {
    const agents = await this.repository.listAgents(ownerId);
    return agents.map((agent) => this.toPublicAgent(agent));
  }

  async getAgent(id: string, ownerId: string): Promise<Agent> {
    const agent = await this.repository.getAgent(id, ownerId);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return this.toPublicAgent(agent);
  }

  async createAgent(input: CreateAgentInput, ownerId: string): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const persisted: PersistedAgent = {
      id,
      ownerId,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const agent = this.toPublicAgent(persisted);
    await this.workspaces.create(agent);
    await this.repository.insertAgent(persisted);
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput, ownerId: string): Promise<Agent> {
    const current = await this.getAgent(id, ownerId);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const patch: Partial<PersistedAgent> = { lastError: null, updatedAt: now() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.description !== undefined) patch.description = input.description.trim();
    if (input.instructions !== undefined) patch.instructions = input.instructions.trim();
    const updated = await this.repository.updateAgent(id, ownerId, patch);
    if (!updated) {
      throw new HttpError(404, "Agent not found");
    }
    const agent = this.toPublicAgent(updated);
    await this.workspaces.writeInstructions(agent);
    return agent;
  }

  async deleteAgent(id: string, ownerId: string): Promise<{ archivedWorkspace: string | null }> {
    const agent = await this.getAgent(id, ownerId);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.repository.deleteAgent(id, ownerId);
    return { archivedWorkspace };
  }

  async startAgent(id: string, ownerId: string): Promise<Agent> {
    await this.getAgent(id, ownerId);
    return this.setStatus(id, ownerId, "ready");
  }

  async stopAgent(id: string, ownerId: string): Promise<Agent> {
    await this.getAgent(id, ownerId);
    await this.cancelExecution(id);
    return this.setStatus(id, ownerId, "stopped");
  }

  async getMessages(agentId: string, ownerId: string): Promise<Message[]> {
    await this.getAgent(agentId, ownerId);
    return this.repository.listMessages(agentId);
  }

  async getRun(runId: string, ownerId: string): Promise<AgentRun> {
    const run = await this.repository.getRun(runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    await this.getAgent(run.agentId, ownerId);
    return run;
  }

  async getRuns(agentId: string, ownerId: string): Promise<AgentRun[]> {
    await this.getAgent(agentId, ownerId);
    return this.repository.listRuns(agentId);
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    ownerId: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const agentAtStart = await this.repository.beginRun(agentId, ownerId);
    if (!agentAtStart) {
      throw new HttpError(404, "Agent not found");
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    await this.repository.insertRun(run);
    await this.repository.insertMessage(message);

    const execution = this.executeRun(this.toPublicAgent(agentAtStart), run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.repository.updateRun(run.id, { status: "running", startedAt: now() });

    // An Agent synced from another machine has no local workspace or Codex
    // session yet. Provision one now and start a fresh Codex session rather
    // than trying (and failing) to resume a thread that only ever existed
    // on the machine that created it.
    let threadId = agentAtStart.codexThreadId;
    if (!(await this.workspaces.exists(agentAtStart.id))) {
      await this.workspaces.create(agentAtStart);
      threadId = null;
      await this.repository.updateAgent(agentAtStart.id, agentAtStart.ownerId, {
        codexThreadId: null,
      });
    }

    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId,
      });
      const completedAt = now();
      await this.repository.updateRun(run.id, {
        status: "completed",
        output: result.output,
        usage: result.usage,
        completedAt,
      });
      await this.repository.insertMessage({
        id: randomUUID(),
        agentId: agentAtStart.id,
        runId: run.id,
        role: "assistant",
        content: result.output,
        createdAt: completedAt,
      });
      await this.repository.updateAgent(agentAtStart.id, agentAtStart.ownerId, {
        status: "ready",
        codexThreadId: result.threadId,
        lastError: null,
        updatedAt: completedAt,
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.updateRun(run.id, {
        status: cancelled ? "cancelled" : "failed",
        error: message,
        completedAt,
      });
      const latest = await this.repository.getAgent(agentAtStart.id, agentAtStart.ownerId);
      if (latest && latest.status !== "stopped") {
        await this.repository.updateAgent(agentAtStart.id, agentAtStart.ownerId, {
          status: cancelled ? "ready" : "error",
          lastError: cancelled ? null : message,
          updatedAt: completedAt,
        });
      }
    }
  }

  private async setStatus(id: string, ownerId: string, status: Agent["status"]): Promise<Agent> {
    if (status === "ready") {
      const current = await this.repository.getAgent(id, ownerId);
      if (current?.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
    }
    const patch: Partial<PersistedAgent> = { status, updatedAt: now() };
    if (status === "ready") patch.lastError = null;
    const updated = await this.repository.updateAgent(id, ownerId, patch);
    if (!updated) {
      throw new HttpError(404, "Agent not found");
    }
    return this.toPublicAgent(updated);
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
