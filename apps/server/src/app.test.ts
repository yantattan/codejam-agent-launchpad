import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import type { AuthUser, UserVerifier } from "./auth.js";

const service = {
  listAgents: () => [],
  getAgent: () => {
    throw Object.assign(new Error("Agent not found"), { statusCode: 404 });
  },
  systemInfo: async () => ({}),
} as unknown as AgentService;

const validUserToken = "valid-user-token";
const fakeUser: AuthUser = { id: "test-user-id", email: "demo@example.com" };
const fakeVerifier: UserVerifier = {
  async verify(token: string) {
    return token === validUserToken ? fakeUser : null;
  },
};

describe("HTTP boundary", () => {
  it("requires per-user sign-in on Agent routes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, fakeVerifier);

    const noToken = await app.inject({ method: "GET", url: "/api/agents" });
    expect(noToken.statusCode).toBe(401);

    const badToken = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-supabase-token": "not-a-real-token" },
    });
    expect(badToken.statusCode).toBe(401);

    const goodToken = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-supabase-token": validUserToken },
    });
    expect(goodToken.statusCode).toBe(200);
    await app.close();
  });

  it("does not require sign-in on routes outside /api/agents and /api/runs", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, fakeVerifier);
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, fakeVerifier);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", "x-supabase-token": validUserToken },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", "x-supabase-token": validUserToken },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });
});
