import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { InjectionScanner } from "./injection-scanner.js";
import type { AgentRepository, PersistedAgent } from "./repository.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  ScanVerdict,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import type { TransactionHandle, WorkspaceTransactionManager } from "./workspace-transaction.js";

const now = () => new Date().toISOString();

function describeScan(verdict: ScanVerdict): string {
  const blocking = verdict.findings.filter((item) => item.severity === "malicious");
  const list = (blocking.length > 0 ? blocking : verdict.findings).slice(0, 3);
  return list
    .map(
      (item) =>
        (item.path ? "[" + item.path + "] " : "") +
        item.technique +
        ": " +
        item.detail +
        ' — "' +
        item.excerpt +
        '"',
    )
    .join(" | ");
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly repository: AgentRepository,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly scanner: InjectionScanner,
    private readonly transactions: WorkspaceTransactionManager,
  ) {}

  async initialize(): Promise<void> {
    await this.repository.initialize();
    await this.workspaces.initialize();
    await this.transactions.initialize();
    await this.repository.resetStaleExecutionState();
    await this.transactions.cleanupStale();
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
    await this.discardPendingTransactionIfAny(agent);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.repository.deleteAgent(id, ownerId);
    return { archivedWorkspace };
  }

  async startAgent(id: string, ownerId: string): Promise<Agent> {
    await this.getAgent(id, ownerId);
    return this.setStatus(id, ownerId, "ready");
  }

  async stopAgent(id: string, ownerId: string): Promise<Agent> {
    const agent = await this.getAgent(id, ownerId);
    await this.cancelExecution(id);
    await this.discardPendingTransactionIfAny(agent);
    return this.setStatus(id, ownerId, "stopped");
  }

  /**
   * Confirms a pending proposal: swaps the staged copy into the real
   * workspace. Guarded against acting on a stale run — if a follow-up
   * refinement has already produced a newer pending run for this Agent,
   * that newer one is the only one still backed by a live staging copy.
   */
  async confirmRun(runId: string, ownerId: string): Promise<AgentRun> {
    const run = await this.getRun(runId, ownerId);
    const agent = await this.getAgent(run.agentId, ownerId);
    if (run.status !== "pending_confirmation") {
      throw new HttpError(409, "This run is not awaiting confirmation");
    }
    if ((await this.latestRun(agent.id))?.id !== run.id) {
      throw new HttpError(409, "This proposal has been superseded by a newer one");
    }
    const handle = await this.transactions.begin(agent.id, agent.workspacePath);
    await this.transactions.commit(handle);
    const completedAt = now();
    const updated = await this.repository.updateRun(runId, { status: "completed", completedAt });
    if (!updated) {
      throw new HttpError(404, "Run not found");
    }
    if (agent.status !== "stopped") {
      await this.repository.updateAgent(agent.id, ownerId, { status: "ready", updatedAt: completedAt });
    }
    return updated;
  }

  /**
   * Discards a pending proposal: the staged copy is deleted, the real
   * workspace was never touched. Same staleness guard as confirmRun.
   */
  async discardRun(runId: string, ownerId: string): Promise<AgentRun> {
    const run = await this.getRun(runId, ownerId);
    const agent = await this.getAgent(run.agentId, ownerId);
    if (run.status !== "pending_confirmation") {
      throw new HttpError(409, "This run is not awaiting confirmation");
    }
    if ((await this.latestRun(agent.id))?.id !== run.id) {
      throw new HttpError(409, "This proposal has been superseded by a newer one");
    }
    const handle = await this.transactions.begin(agent.id, agent.workspacePath);
    await this.transactions.rollback(handle);
    const completedAt = now();
    const updated = await this.repository.updateRun(runId, { status: "discarded", completedAt });
    if (!updated) {
      throw new HttpError(404, "Run not found");
    }
    if (agent.status !== "stopped") {
      await this.repository.updateAgent(agent.id, ownerId, { status: "ready", updatedAt: completedAt });
    }
    return updated;
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
    const agent = await this.getAgent(agentId, ownerId);
    const promptScan = await this.scanner.scan(agent, [{ source: "prompt", text: prompt }]);
    if (promptScan.blocked) {
      throw new HttpError(
        422,
        "Blocked: potential prompt injection detected. " + describeScan(promptScan),
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
      scan: promptScan,
      pendingChanges: null,
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

    const execution = this.executeRun(this.toPublicAgent(agentAtStart), run, promptScan);
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

  private async executeRun(agentAtStart: Agent, run: AgentRun, promptScan: ScanVerdict): Promise<void> {
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

    let handle: TransactionHandle | null = null;
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }

      // Every run works in an isolated staged copy of the workspace — the
      // real one is only ever touched at explicit user confirmation. If a
      // proposal from an earlier turn is still pending, this reuses that
      // same staged copy instead of starting over, so a follow-up prompt
      // refines the same proposal rather than losing it.
      handle = await this.transactions.begin(agentAtStart.id, agentAtStart.workspacePath);

      // Scan the workspace on every turn (including resumed threads) —
      // this is what Codex is about to read this turn, and catches content
      // that arrived after the Agent was created (a file added between
      // turns, or by a prior turn's own output). Scanned from the staged
      // copy, since that's what the Runner is about to actually read.
      const {
        files,
        truncated: filesTruncated,
        extraFindings,
      } = await this.workspaces.readScannableFiles({ ...agentAtStart, workspacePath: handle.workingPath });
      const fileScan = await this.scanner.scan(
        agentAtStart,
        files.map((file) => ({ source: "workspace-file" as const, path: file.path, text: file.content })),
      );
      const allFindings = [...promptScan.findings, ...fileScan.findings, ...extraFindings];
      const combinedScan: ScanVerdict = {
        blocked: allFindings.some((item) => item.severity === "malicious"),
        findings: allFindings,
        scannedAt: now(),
        ...((promptScan.truncated ?? false) || (fileScan.truncated ?? false) || filesTruncated
          ? { truncated: true }
          : {}),
      };

      if (combinedScan.blocked) {
        // Fail closed: a scan hit means the whole pending proposal is
        // discarded, not just this turn's delta — nothing suspect stays
        // staged waiting for a later confirm.
        await this.transactions.rollback(handle);
        const completedAt = now();
        await this.repository.updateRun(run.id, {
          status: "blocked",
          scan: combinedScan,
          error: "Blocked by prompt-injection scan: " + describeScan(combinedScan),
          completedAt,
        });
        const latest = await this.repository.getAgent(agentAtStart.id, agentAtStart.ownerId);
        if (latest && latest.status !== "stopped") {
          await this.repository.updateAgent(agentAtStart.id, agentAtStart.ownerId, {
            status: "ready",
            updatedAt: completedAt,
          });
        }
        return;
      }

      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: handle.workingPath,
        prompt: run.prompt,
        threadId,
      });

      const { files: changedFiles, truncated: changesTruncated } = await this.transactions.diffChanges(handle);
      const completedAt = now();

      if (changedFiles.length === 0) {
        // Nothing to review — commit is a same-content swap, so this stays
        // as frictionless as a plain Q&A turn always was.
        await this.transactions.commit(handle);
        await this.repository.updateRun(run.id, {
          status: "completed",
          output: result.output,
          usage: result.usage,
          scan: combinedScan,
          pendingChanges: null,
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
        return;
      }

      // Files changed — hold for the user's review. The real workspace
      // has not been touched; the Agent stays "busy" until confirm/discard.
      await this.repository.updateRun(run.id, {
        status: "pending_confirmation",
        output: result.output,
        usage: result.usage,
        scan: combinedScan,
        pendingChanges: { files: changedFiles, truncated: changesTruncated },
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
        codexThreadId: result.threadId,
        lastError: null,
        updatedAt: completedAt,
        // status stays "busy" — waiting on the user's decision.
      });
    } catch (error) {
      if (handle) {
        await this.transactions.rollback(handle).catch(() => undefined);
      }
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

  private async latestRun(agentId: string): Promise<AgentRun | undefined> {
    const runs = await this.repository.listRuns(agentId);
    return runs[0];
  }

  /** Used when stopping or deleting an Agent that has a proposal still
   * awaiting review — leaves no orphaned staging directory and no run
   * stuck forever in "pending_confirmation". */
  private async discardPendingTransactionIfAny(agent: Agent): Promise<void> {
    if (!(await this.transactions.hasActive(agent.id))) return;
    const handle = await this.transactions.begin(agent.id, agent.workspacePath);
    await this.transactions.rollback(handle);
    const runs = await this.repository.listRuns(agent.id);
    const pending = runs.find((run) => run.status === "pending_confirmation");
    if (pending) {
      await this.repository.updateRun(pending.id, { status: "discarded", completedAt: now() });
    }
  }
}
