import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export interface ScannableFile {
  /** Relative to the Agent's workspace root, forward-slash separated. */
  path: string;
  content: string;
}

const SKIP_DIR_NAMES = new Set([".git", ".codex", "node_modules", "dist", ".deleted"]);
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_BYTES_PER_FILE = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  /**
   * Reads every non-binary file currently in the Agent's workspace, bounded
   * by count/size caps — this is exactly what Codex is about to read this
   * turn, scanned before it does. Read errors on individual entries are
   * skipped rather than failing the whole scan.
   */
  async readScannableFiles(
    agent: Agent,
    opts: { maxFiles?: number; maxBytesPerFile?: number; maxTotalBytes?: number } = {},
  ): Promise<{ files: ScannableFile[]; truncated: boolean }> {
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    const maxBytesPerFile = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
    const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

    const files: ScannableFile[] = [];
    let totalBytes = 0;
    let truncated = false;

    const withinBudget = () => files.length < maxFiles && totalBytes < maxTotalBytes;

    const walk = async (dir: string): Promise<void> => {
      if (!withinBudget()) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!withinBudget()) {
          truncated = true;
          return;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIR_NAMES.has(entry.name)) continue;
          await walk(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        let fileStat;
        try {
          fileStat = await stat(fullPath);
        } catch {
          continue;
        }
        if (fileStat.size === 0 || fileStat.size > maxBytesPerFile) continue;
        let buffer;
        try {
          buffer = await readFile(fullPath);
        } catch {
          continue;
        }
        if (buffer.subarray(0, 512).includes(0)) continue; // binary sniff
        totalBytes += buffer.byteLength;
        files.push({
          path: path.relative(agent.workspacePath, fullPath).split(path.sep).join("/"),
          content: buffer.toString("utf8"),
        });
      }
    };

    await walk(agent.workspacePath);
    return { files, truncated };
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
