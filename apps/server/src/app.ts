import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { UserVerifier } from "./auth.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string | null;
  }
}

function requireUserId(request: FastifyRequest): string {
  if (!request.userId) {
    throw new HttpError(401, "Sign in required");
  }
  return request.userId;
}

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});

export async function createApp(
  config: AppConfig,
  service: AgentService,
  userVerifier: UserVerifier,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-supabase-token']",
      ],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  // Per-user identity: every Agent/Run request must carry a Supabase
  // session token identifying who is calling.
  app.decorateRequest("userId", null);
  app.addHook("onRequest", async (request, reply) => {
    const needsUser =
      request.url.startsWith("/api/agents") || request.url.startsWith("/api/runs");
    if (!needsUser) return;
    const header = request.headers["x-supabase-token"];
    const token = Array.isArray(header) ? header[0] : header;
    const user = token ? await userVerifier.verify(token) : null;
    if (!user) {
      return reply.code(401).send({ error: "Sign in required" });
    }
    request.userId = user.id;
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request) => ({
    agents: await service.listAgents(requireUserId(request)),
  }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body, requireUserId(request));
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.getAgent(id, requireUserId(request)) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body, requireUserId(request)) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return await service.deleteAgent(id, requireUserId(request));
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id, requireUserId(request)) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id, requireUserId(request)) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: await service.getMessages(id, requireUserId(request)) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: await service.getRuns(id, requireUserId(request)) };
  });

  app.get("/api/agents/:id/undo", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { available: await service.canUndo(id, requireUserId(request)) };
  });

  app.post("/api/agents/:id/undo", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.undoLastCommit(id, requireUserId(request)) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, requireUserId(request));
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: await service.getRun(id, requireUserId(request)) };
  });

  app.post("/api/runs/:id/confirm", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: await service.confirmRun(id, requireUserId(request)) };
  });

  app.post("/api/runs/:id/discard", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: await service.discardRun(id, requireUserId(request)) };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
