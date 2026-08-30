import { describe, expect, it } from "vitest";
import {
  agentFromRow,
  agentToRow,
  messageFromRow,
  messageToRow,
  runFromRow,
  runToRow,
} from "./supabase-repository.js";
import type { PersistedAgent } from "./repository.js";
import type { AgentRun, Message } from "./types.js";

describe("Supabase row mapping", () => {
  it("round-trips an Agent through snake_case columns", () => {
    const agent: PersistedAgent = {
      id: "agent-1",
      ownerId: "owner-1",
      name: "Builder",
      description: "Builds things",
      instructions: "Be helpful",
      status: "ready",
      codexThreadId: "thread-1",
      lastError: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(agentFromRow(agentToRow(agent))).toEqual(agent);
  });

  it("round-trips a Message", () => {
    const message: Message = {
      id: "msg-1",
      agentId: "agent-1",
      runId: "run-1",
      role: "assistant",
      content: "Done!",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(messageFromRow(messageToRow(message))).toEqual(message);
  });

  it("round-trips an AgentRun including usage", () => {
    const run: AgentRun = {
      id: "run-1",
      agentId: "agent-1",
      status: "completed",
      prompt: "hello",
      output: "hi",
      error: null,
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4 },
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(runFromRow(runToRow(run))).toEqual(run);
  });
});
