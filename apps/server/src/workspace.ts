import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { scanPdfBuffer } from "./pdf-scanner.js";
import type { Agent, ScanFinding } from "./types.js";

export interface ScannableFile {
  /** Relative to the Agent's workspace root, forward-slash separated. */
  path: string;
  content: string;
}

const PDF_MAGIC = "%PDF-";

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC;
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
  ): Promise<{ files: ScannableFile[]; truncated: boolean; extraFindings: ScanFinding[] }> {
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    const maxBytesPerFile = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
    const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

    const files: ScannableFile[] = [];
    const extraFindings: ScanFinding[] = [];
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
        const relativePath = path.relative(agent.workspacePath, fullPath).split(path.sep).join("/");

        if (looksLikePdf(buffer)) {
          // Parsed directly with the same library family a naive ingestion
          // pipeline would use, rather than trusting the rendered page —
          // see pdf-scanner.ts for why.
          const extraction = await scanPdfBuffer(buffer, relativePath);
          extraFindings.push(...extraction.visualFindings);
          const combined = [
            extraction.text,
            Object.keys(extraction.metadata).length > 0
              ? "[PDF metadata]\n" +
                Object.entries(extraction.metadata)
                  .map(([key, value]) => key + ": " + value)
                  .join("\n")
              : "",
            extraction.annotationText.length > 0
              ? "[PDF annotations]\n" + extraction.annotationText.join("\n")
              : "",
          ]
            .filter(Boolean)
            .join("\n\n");
          totalBytes += buffer.byteLength;
          files.push({ path: relativePath, content: combined });
          continue;
        }

        if (buffer.subarray(0, 512).includes(0)) {
          // Not text and not a PDF we know how to parse — flag rather than
          // silently vanish, so an operator can see something was skipped.
          extraFindings.push({
            tier: "static",
            severity: "suspicious",
            technique: "unparsed-binary-format",
            source: "workspace-file",
            path: relativePath,
            excerpt: "(binary content, " + buffer.byteLength + " bytes)",
            detail: "This file's format isn't inspected by the scanner (not text, not a recognized PDF) — its contents were not checked.",
          });
          continue;
        }
        totalBytes += buffer.byteLength;
        files.push({ path: relativePath, content: buffer.toString("utf8") });
      }
    };

    await walk(agent.workspacePath);
    return { files, truncated, extraFindings };
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
