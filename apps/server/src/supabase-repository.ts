import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./errors.js";
import type { AgentRepository, PersistedAgent } from "./repository.js";
import type { AgentRun, Message, PendingChangeSet, ScanVerdict } from "./types.js";

const now = () => new Date().toISOString();

interface AgentRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  instructions: string;
  status: PersistedAgent["status"];
  codex_thread_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  agent_id: string;
  run_id: string;
  role: Message["role"];
  content: string;
  created_at: string;
}

interface RunRow {
  id: string;
  agent_id: string;
  status: AgentRun["status"];
  prompt: string;
  output: string | null;
  error: string | null;
  usage: AgentRun["usage"];
  scan: ScanVerdict | null;
  pending_changes: PendingChangeSet | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export function agentFromRow(row: AgentRow): PersistedAgent {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    status: row.status,
    codexThreadId: row.codex_thread_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function agentToRow(agent: PersistedAgent): AgentRow {
  return {
    id: agent.id,
    owner_id: agent.ownerId,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    status: agent.status,
    codex_thread_id: agent.codexThreadId,
    last_error: agent.lastError,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };
}

function agentPatchToRow(patch: Partial<PersistedAgent>): Partial<AgentRow> {
  const row: Partial<AgentRow> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.instructions !== undefined) row.instructions = patch.instructions;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.codexThreadId !== undefined) row.codex_thread_id = patch.codexThreadId;
  if (patch.lastError !== undefined) row.last_error = patch.lastError;
  if (patch.updatedAt !== undefined) row.updated_at = patch.updatedAt;
  return row;
}

export function messageFromRow(row: MessageRow): Message {
  return {
    id: row.id,
    agentId: row.agent_id,
    runId: row.run_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

export function messageToRow(message: Message): MessageRow {
  return {
    id: message.id,
    agent_id: message.agentId,
    run_id: message.runId,
    role: message.role,
    content: message.content,
    created_at: message.createdAt,
  };
}

export function runFromRow(row: RunRow): AgentRun {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    prompt: row.prompt,
    output: row.output,
    error: row.error,
    usage: row.usage,
    scan: row.scan,
    pendingChanges: row.pending_changes,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

export function runToRow(run: AgentRun): RunRow {
  return {
    id: run.id,
    agent_id: run.agentId,
    status: run.status,
    prompt: run.prompt,
    output: run.output,
    error: run.error,
    usage: run.usage,
    scan: run.scan,
    pending_changes: run.pendingChanges,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    created_at: run.createdAt,
  };
}

function runPatchToRow(patch: Partial<AgentRun>): Partial<RunRow> {
  const row: Partial<RunRow> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.output !== undefined) row.output = patch.output;
  if (patch.error !== undefined) row.error = patch.error;
  if (patch.usage !== undefined) row.usage = patch.usage;
  if (patch.scan !== undefined) row.scan = patch.scan;
  if (patch.pendingChanges !== undefined) row.pending_changes = patch.pendingChanges;
  if (patch.startedAt !== undefined) row.started_at = patch.startedAt;
  if (patch.completedAt !== undefined) row.completed_at = patch.completedAt;
  return row;
}

/**
 * Postgres-backed AgentRepository using Supabase's service_role key, which
 * bypasses Row Level Security — ownership is enforced here in application
 * code (every query filters by owner_id), the same trust boundary the
 * platform already uses. RLS policies still exist on these tables as
 * defense-in-depth for any future direct-from-browser access.
 */
export class SupabaseAgentRepository implements AgentRepository {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async initialize(): Promise<void> {
    const { error } = await this.client.from("agents").select("id").limit(1);
    if (error) {
      throw new Error(
        "Could not reach the Supabase 'agents' table. Run the setup SQL from " +
          "README.md#authentication-supabase and check SUPABASE_SERVICE_ROLE_KEY. " +
          "Detail: " +
          error.message,
      );
    }
  }

  async listAgents(ownerId: string): Promise<PersistedAgent[]> {
    const { data, error } = await this.client
      .from("agents")
      .select("*")
      .eq("owner_id", ownerId)
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data as AgentRow[]).map(agentFromRow);
  }

  async getAgent(id: string, ownerId: string): Promise<PersistedAgent | null> {
    const { data, error } = await this.client
      .from("agents")
      .select("*")
      .eq("id", id)
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? agentFromRow(data as AgentRow) : null;
  }

  async insertAgent(agent: PersistedAgent): Promise<void> {
    const { error } = await this.client.from("agents").insert(agentToRow(agent));
    if (error) throw new Error(error.message);
  }

  async updateAgent(
    id: string,
    ownerId: string,
    patch: Partial<PersistedAgent>,
  ): Promise<PersistedAgent | null> {
    const { data, error } = await this.client
      .from("agents")
      .update(agentPatchToRow(patch))
      .eq("id", id)
      .eq("owner_id", ownerId)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? agentFromRow(data as AgentRow) : null;
  }

  async deleteAgent(id: string, ownerId: string): Promise<PersistedAgent | null> {
    const { data, error } = await this.client
      .from("agents")
      .delete()
      .eq("id", id)
      .eq("owner_id", ownerId)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? agentFromRow(data as AgentRow) : null;
  }

  async listMessages(agentId: string): Promise<Message[]> {
    const { data, error } = await this.client
      .from("messages")
      .select("*")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data as MessageRow[]).map(messageFromRow);
  }

  async insertMessage(message: Message): Promise<void> {
    const { error } = await this.client.from("messages").insert(messageToRow(message));
    if (error) throw new Error(error.message);
  }

  async listRuns(agentId: string): Promise<AgentRun[]> {
    const { data, error } = await this.client
      .from("runs")
      .select("*")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data as RunRow[]).map(runFromRow);
  }

  async getRun(id: string): Promise<AgentRun | null> {
    const { data, error } = await this.client.from("runs").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? runFromRow(data as RunRow) : null;
  }

  async insertRun(run: AgentRun): Promise<void> {
    const { error } = await this.client.from("runs").insert(runToRow(run));
    if (error) throw new Error(error.message);
  }

  async updateRun(id: string, patch: Partial<AgentRun>): Promise<AgentRun | null> {
    const { data, error } = await this.client
      .from("runs")
      .update(runPatchToRow(patch))
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? runFromRow(data as RunRow) : null;
  }

  async beginRun(agentId: string, ownerId: string): Promise<PersistedAgent | null> {
    const current = await this.getAgent(agentId, ownerId);
    if (!current) {
      throw new HttpError(404, "Agent not found");
    }
    if (current.status === "stopped") {
      throw new HttpError(409, "Start the Agent before sending a message");
    }
    if (current.status === "busy") {
      // A follow-up message while a proposal is awaiting confirmation is a
      // refinement of that same proposal, not a conflicting new task —
      // everything else still counts as "already running".
      const { data: latestRuns, error: latestError } = await this.client
        .from("runs")
        .select("status")
        .eq("agent_id", agentId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (latestError) throw new Error(latestError.message);
      const latestStatus = (latestRuns as Array<{ status: AgentRun["status"] }> | null)?.[0]?.status;
      if (latestStatus !== "pending_confirmation") {
        throw new HttpError(409, "This Agent is already running");
      }
      return current;
    }
    // Conditional on the status we just read, so two concurrent requests
    // (even from different machines) can't both win this race.
    const { data, error } = await this.client
      .from("agents")
      .update({ status: "busy", last_error: null, updated_at: now() })
      .eq("id", agentId)
      .eq("owner_id", ownerId)
      .eq("status", current.status)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      throw new HttpError(409, "This Agent is already running");
    }
    return current;
  }

  async resetStaleExecutionState(): Promise<void> {
    const { error: runsError } = await this.client
      .from("runs")
      .update({
        status: "cancelled",
        error: "Server restarted while this run was active",
        completed_at: now(),
      })
      .in("status", ["queued", "running", "pending_confirmation"]);
    if (runsError) throw new Error(runsError.message);

    const { error: agentsError } = await this.client
      .from("agents")
      .update({ status: "ready", updated_at: now() })
      .eq("status", "busy");
    if (agentsError) throw new Error(agentsError.message);
  }
}
