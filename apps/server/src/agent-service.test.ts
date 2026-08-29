import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" }, ownerA);
    expect(service.listAgents(ownerA)).toHaveLength(1);
    expect(
      (await service.updateAgent(agent.id, { description: "Builds apps" }, ownerA)).description,
    ).toBe("Builds apps");
    expect((await service.stopAgent(agent.id, ownerA)).status).toBe("stopped");
    expect((await service.startAgent(agent.id, ownerA)).status).toBe("ready");
    await service.deleteAgent(agent.id, ownerA);
    expect(service.listAgents(ownerA)).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" }, ownerA);
    const { run } = await service.sendMessage(agent.id, "write hello world", ownerA);
    await expect.poll(() => service.getRun(run.id, ownerA).status).toBe("completed");
    const messages = service.getMessages(agent.id, ownerA);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id, ownerA).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" }, ownerA);
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first", ownerA),
      service.sendMessage(agent.id, "second", ownerA),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id, ownerA)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect
        .poll(() => service.getRun(accepted.value.run.id, ownerA).status)
        .toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" }, ownerA);
    const { run } = await service.sendMessage(agent.id, "first", ownerA);

    await expect(service.startAgent(agent.id, ownerA)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(service.sendMessage(agent.id, "second", ownerA)).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id, ownerA).status).toBe("completed");
  });
});

describe("Ownership isolation", () => {
  it("hides User A's Agent from User B across every read and write path", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Private" }, ownerA);

    await expect(async () => service.getAgent(agent.id, ownerB)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.updateAgent(agent.id, { name: "Hijacked" }, ownerB),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.startAgent(agent.id, ownerB)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.stopAgent(agent.id, ownerB)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(() => service.getMessages(agent.id, ownerB)).toThrowError(
      expect.objectContaining({ statusCode: 404 }),
    );
    expect(() => service.getRuns(agent.id, ownerB)).toThrowError(
      expect.objectContaining({ statusCode: 404 }),
    );
    // The explicit "prompt authorization" check: User B cannot send a
    // message to an Agent User A owns, even knowing its exact id.
    await expect(
      service.sendMessage(agent.id, "steal this workspace", ownerB),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.deleteAgent(agent.id, ownerB)).rejects.toMatchObject({
      statusCode: 404,
    });

    // User A is unaffected and still owns a working Agent.
    expect(service.getAgent(agent.id, ownerA).name).toBe("Private");
    expect(service.listAgents(ownerB)).toHaveLength(0);
    expect(service.listAgents(ownerA)).toHaveLength(1);
  });

  it("a run started by User A cannot be read through User B's id", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" }, ownerA);
    const { run } = await service.sendMessage(agent.id, "hello", ownerA);
    await expect.poll(() => service.getRun(run.id, ownerA).status).toBe("completed");

    await expect(async () => service.getRun(run.id, ownerB)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
