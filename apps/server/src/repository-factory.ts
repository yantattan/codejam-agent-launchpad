import path from "node:path";
import type { AppConfig } from "./config.js";
import { isSupabaseDataStoreConfigured } from "./config.js";
import { JsonAgentRepository } from "./json-repository.js";
import type { AgentRepository } from "./repository.js";
import { SupabaseAgentRepository } from "./supabase-repository.js";
import { JsonStore } from "./store.js";

export function createRepository(config: AppConfig): AgentRepository {
  if (isSupabaseDataStoreConfigured(config)) {
    return new SupabaseAgentRepository(config.supabaseUrl, config.supabaseServiceRoleKey);
  }
  const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
  return new JsonAgentRepository(store, (agentId) => path.join(config.workspaceRoot, agentId));
}
