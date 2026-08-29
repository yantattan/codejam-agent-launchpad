import { config as loadEnvFile } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { SupabaseUserVerifier, UnconfiguredVerifier } from "./auth.js";
import { isSupabaseConfigured, loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

// Node never reads .env on its own. This loads the repo-root .env (two
// directories above apps/server, whether running from src/ via tsx or
// dist/ via node) without overriding variables the shell already set —
// e.g. real env vars injected by docker-compose or an ECS deployment.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
loadEnvFile({ path: path.join(repoRoot, ".env") });

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();

if (!isSupabaseConfigured(config)) {
  console.warn(
    "SUPABASE_URL/SUPABASE_ANON_KEY are not set. Every /api/agents and /api/runs " +
      "request will be rejected with 401 until Supabase Auth is configured.",
  );
}
const userVerifier = isSupabaseConfigured(config)
  ? new SupabaseUserVerifier(config.supabaseUrl, config.supabaseAnonKey)
  : new UnconfiguredVerifier();

const app = await createApp(config, service, userVerifier);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
