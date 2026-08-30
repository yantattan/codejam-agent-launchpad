import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { diffLines } from "diff";
import type { DiffLine, FileChange, FileChangeKind } from "./types.js";

export interface TransactionHandle {
  agentId: string;
  /** The Agent's real, durable workspace — never touched until commit. */
  persistentPath: string;
  /** The path the Runner should actually read/write for this run. */
  workingPath: string;
}

/**
 * Directories the transaction never copies or diffs — regenerable
 * build/dependency output, matching WorkspaceManager's generated
 * .gitignore. This matters beyond performance: when the Runtime is a
 * Docker container, symlinks it creates inside node_modules/.bin can
 * throw EACCES on lstat when a native Windows host process later tries to
 * copy them — a known Docker Desktop bind-mount quirk. Excluded
 * directories are carried forward untouched on commit (see
 * carryForwardExcluded) rather than being part of the staged, diffable
 * content. `.codex` is excluded too, but that's safe for thread
 * continuity: Codex's own session state lives in the global CODEX_HOME
 * directory, not in a per-workspace .codex folder.
 */
const EXCLUDED_DIR_NAMES = new Set([".git", ".codex", "node_modules", "dist"]);
const MAX_DIFF_BYTES_PER_FILE = 256 * 1024;
const BINARY_SNIFF_BYTES = 512;

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Moves any excluded directory (node_modules, etc.) from the old
 * persistent snapshot into the newly-committed one — those never got
 * staged, so without this they'd silently disappear on every commit. */
async function carryForwardExcluded(previousDir: string, newDir: string): Promise<void> {
  for (const name of EXCLUDED_DIR_NAMES) {
    const destination = path.join(newDir, name);
    if (await pathExists(destination)) continue;
    const source = path.join(previousDir, name);
    if (!(await pathExists(source))) continue;
    await rename(source, destination);
  }
}

async function listFiles(root: string): Promise<Set<string>> {
  const result = new Set<string>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      result.add(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return result;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function toDiffLines(before: string, after: string): DiffLine[] {
  return diffLines(before, after).map((part) => ({
    value: part.value,
    ...(part.added ? { added: true } : {}),
    ...(part.removed ? { removed: true } : {}),
  }));
}

async function describeChangedFile(
  relativePath: string,
  kind: FileChangeKind,
  persistentPath: string,
  workingPath: string,
): Promise<FileChange> {
  const before = kind !== "created" ? path.join(persistentPath, relativePath) : null;
  const after = kind !== "deleted" ? path.join(workingPath, relativePath) : null;

  const sizeBefore = before ? (await stat(before)).size : null;
  const sizeAfter = after ? (await stat(after)).size : null;
  const tooLarge = (sizeBefore ?? 0) > MAX_DIFF_BYTES_PER_FILE || (sizeAfter ?? 0) > MAX_DIFF_BYTES_PER_FILE;

  const base: FileChange = {
    path: relativePath,
    kind,
    isBinary: tooLarge,
    sizeBefore,
    sizeAfter,
  };

  if (tooLarge) return base;

  const beforeBuffer = before ? await readFile(before) : null;
  const afterBuffer = after ? await readFile(after) : null;
  const isBinary =
    Boolean(beforeBuffer && isBinaryBuffer(beforeBuffer)) || Boolean(afterBuffer && isBinaryBuffer(afterBuffer));

  if (isBinary) return { ...base, isBinary: true };

  const beforeText = beforeBuffer?.toString("utf8") ?? "";
  const afterText = afterBuffer?.toString("utf8") ?? "";

  if (kind === "modified") return { ...base, diff: toDiffLines(beforeText, afterText) };
  if (kind === "created") return { ...base, contentAfter: afterText };
  return { ...base, contentBefore: beforeText };
}

/**
 * Walks two directory trees and reports every created/modified/deleted
 * file between them, with a line diff or full content attached for text
 * files under the size cap. Same-size files are byte-compared (not just
 * size checked) so a same-length edit still counts as modified.
 */
export async function computeChanges(persistentPath: string, workingPath: string): Promise<{
  files: FileChange[];
  truncated: boolean;
}> {
  const [before, after] = await Promise.all([listFiles(persistentPath), listFiles(workingPath)]);
  const changed: Array<{ relativePath: string; kind: FileChangeKind }> = [];

  for (const relativePath of after) {
    if (!before.has(relativePath)) {
      changed.push({ relativePath, kind: "created" });
      continue;
    }
    const [a, b] = await Promise.all([
      readFile(path.join(persistentPath, relativePath)),
      readFile(path.join(workingPath, relativePath)),
    ]);
    if (!a.equals(b)) changed.push({ relativePath, kind: "modified" });
  }
  for (const relativePath of before) {
    if (!after.has(relativePath)) changed.push({ relativePath, kind: "deleted" });
  }

  const files = await Promise.all(
    changed.map((entry) => describeChangedFile(entry.relativePath, entry.kind, persistentPath, workingPath)),
  );
  return { files, truncated: false };
}

export interface WorkspaceTransactionManager {
  initialize(): Promise<void>;
  /** Starts (or, if one is already open for this Agent, resumes) a staged
   * copy of the Agent's workspace. Resuming lets a follow-up prompt keep
   * refining the same pending proposal instead of starting over. */
  begin(agentId: string, persistentPath: string): Promise<TransactionHandle>;
  diffChanges(handle: TransactionHandle): Promise<{ files: FileChange[]; truncated: boolean }>;
  /** Swaps the staged copy into the real workspace's place. */
  commit(handle: TransactionHandle): Promise<void>;
  /** Discards the staged copy; the real workspace is untouched. */
  rollback(handle: TransactionHandle): Promise<void>;
  /** Removes any staging directories left over from an unclean shutdown. */
  cleanupStale(): Promise<number>;
  /** True if a staged copy already exists for this Agent — lets callers
   * avoid triggering a fresh copy (via begin) just to check. */
  hasActive(agentId: string): Promise<boolean>;
}

export class FileSystemWorkspaceTransactionManager implements WorkspaceTransactionManager {
  constructor(private readonly txRoot: string) {}

  private workingPathFor(agentId: string): string {
    return path.join(this.txRoot, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.txRoot, { recursive: true });
  }

  async hasActive(agentId: string): Promise<boolean> {
    return pathExists(this.workingPathFor(agentId));
  }

  async begin(agentId: string, persistentPath: string): Promise<TransactionHandle> {
    const workingPath = this.workingPathFor(agentId);
    if (await pathExists(workingPath)) {
      return { agentId, persistentPath, workingPath };
    }
    await cp(persistentPath, workingPath, {
      recursive: true,
      filter: (source) => !EXCLUDED_DIR_NAMES.has(path.basename(source)),
    });
    return { agentId, persistentPath, workingPath };
  }

  async diffChanges(handle: TransactionHandle): Promise<{ files: FileChange[]; truncated: boolean }> {
    return computeChanges(handle.persistentPath, handle.workingPath);
  }

  async commit(handle: TransactionHandle): Promise<void> {
    const previousPath = handle.persistentPath + ".prev-" + handle.agentId;
    await rm(previousPath, { recursive: true, force: true });
    await rename(handle.persistentPath, previousPath);
    await rename(handle.workingPath, handle.persistentPath);
    await carryForwardExcluded(previousPath, handle.persistentPath);
    await rm(previousPath, { recursive: true, force: true });
  }

  async rollback(handle: TransactionHandle): Promise<void> {
    await rm(handle.workingPath, { recursive: true, force: true });
  }

  async cleanupStale(): Promise<number> {
    let entries;
    try {
      entries = await readdir(this.txRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    let count = 0;
    for (const entry of entries) {
      await rm(path.join(this.txRoot, entry.name), { recursive: true, force: true });
      count++;
    }
    return count;
  }
}
