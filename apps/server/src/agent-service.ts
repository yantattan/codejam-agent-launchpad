import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import type { InjectionScanner } from "./injection-scanner.js";
import { JsonStore } from "./store.js";
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
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly scanner: InjectionScanner,
    private readonly transactions: WorkspaceTransactionManager,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.transactions.initialize();
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
    await this.transactions.cleanupStale();
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    await this.discardPendingTransactionIfAny(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    await this.discardPendingTransactionIfAny(id);
    return this.setStatus(id, "stopped");
  }

  /**
   * Confirms a pending proposal: swaps the staged copy into the real
   * workspace. Guarded against acting on a stale run — if a follow-up
   * refinement has already produced a newer pending run for this Agent,
   * that newer one is the only one still backed by a live staging copy.
   */
  async confirmRun(runId: string): Promise<AgentRun> {
    const run = this.getRun(runId);
    const agent = this.getAgent(run.agentId);
    if (run.status !== "pending_confirmation") {
      throw new HttpError(409, "This run is not awaiting confirmation");
    }
    if (this.latestRun(agent.id)?.id !== run.id) {
      throw new HttpError(409, "This proposal has been superseded by a newer one");
    }
    const handle = await this.transactions.begin(agent.id, agent.workspacePath);
    await this.transactions.commit(handle);
    return this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (!storedRun) {
        throw new HttpError(404, "Run not found");
      }
      const completedAt = now();
      storedRun.status = "completed";
      storedRun.completedAt = completedAt;
      if (storedAgent && storedAgent.status !== "stopped") {
        storedAgent.status = "ready";
        storedAgent.updatedAt = completedAt;
      }
      return structuredClone(storedRun);
    });
  }

  /**
   * Discards a pending proposal: the staged copy is deleted, the real
   * workspace was never touched. Same staleness guard as confirmRun.
   */
  async discardRun(runId: string): Promise<AgentRun> {
    const run = this.getRun(runId);
    const agent = this.getAgent(run.agentId);
    if (run.status !== "pending_confirmation") {
      throw new HttpError(409, "This run is not awaiting confirmation");
    }
    if (this.latestRun(agent.id)?.id !== run.id) {
      throw new HttpError(409, "This proposal has been superseded by a newer one");
    }
    const handle = await this.transactions.begin(agent.id, agent.workspacePath);
    await this.transactions.rollback(handle);
    return this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const storedAgent = database.agents.find((item) => item.id === agent.id);
      if (!storedRun) {
        throw new HttpError(404, "Run not found");
      }
      const completedAt = now();
      storedRun.status = "discarded";
      storedRun.completedAt = completedAt;
      if (storedAgent && storedAgent.status !== "stopped") {
        storedAgent.status = "ready";
        storedAgent.updatedAt = completedAt;
      }
      return structuredClone(storedRun);
    });
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const agent = this.getAgent(agentId);
    const promptScan = await this.scanner.scan(agent, [{ source: "prompt", text: prompt }]);
    if (promptScan.blocked) {
      throw new HttpError(
        422,
        "Blocked: potential prompt injection detected. " + describeScan(promptScan),
      );
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
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
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
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run, promptScan);
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

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    promptScan: ScanVerdict,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
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
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (storedRun) {
            storedRun.status = "blocked";
            storedRun.scan = combinedScan;
            storedRun.error = "Blocked by prompt-injection scan: " + describeScan(combinedScan);
            storedRun.completedAt = completedAt;
          }
          if (agent && agent.status !== "stopped") {
            agent.status = "ready";
            agent.updatedAt = completedAt;
          }
        });
        return;
      }

      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: handle.workingPath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
      });

      const { files: changedFiles, truncated: changesTruncated } = await this.transactions.diffChanges(handle);
      const completedAt = now();

      if (changedFiles.length === 0) {
        // Nothing to review — commit is a same-content swap, so this stays
        // as frictionless as a plain Q&A turn always was.
        await this.transactions.commit(handle);
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (!storedRun || !agent) return;
          storedRun.status = "completed";
          storedRun.output = result.output;
          storedRun.usage = result.usage;
          storedRun.scan = combinedScan;
          storedRun.pendingChanges = null;
          storedRun.completedAt = completedAt;
          database.messages.push({
            id: randomUUID(),
            agentId: agent.id,
            runId: run.id,
            role: "assistant",
            content: result.output,
            createdAt: completedAt,
          });
          agent.status = "ready";
          agent.codexThreadId = result.threadId;
          agent.lastError = null;
          agent.updatedAt = completedAt;
        });
        return;
      }

      // Files changed — hold for the user's review. The real workspace
      // has not been touched; the Agent stays "busy" until confirm/discard.
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "pending_confirmation";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.scan = combinedScan;
        storedRun.pendingChanges = { files: changedFiles, truncated: changesTruncated };
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      if (handle) {
        await this.transactions.rollback(handle).catch(() => undefined);
      }
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
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

  private latestRun(agentId: string): AgentRun | undefined {
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  /** Used when stopping or deleting an Agent that has a proposal still
   * awaiting review — leaves no orphaned staging directory and no run
   * stuck forever in "pending_confirmation". */
  private async discardPendingTransactionIfAny(agentId: string): Promise<void> {
    if (!(await this.transactions.hasActive(agentId))) return;
    const agent = this.getAgent(agentId);
    const handle = await this.transactions.begin(agentId, agent.workspacePath);
    await this.transactions.rollback(handle);
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.agentId === agentId && run.status === "pending_confirmation") {
          run.status = "discarded";
          run.completedAt = now();
        }
      }
    });
  }
}
