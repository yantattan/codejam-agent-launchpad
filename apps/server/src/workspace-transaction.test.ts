import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemWorkspaceTransactionManager } from "./workspace-transaction.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup(): Promise<{ persistentPath: string; txRoot: string; manager: FileSystemWorkspaceTransactionManager }> {
  const root = await mkdtemp(path.join(tmpdir(), "tx-test-"));
  temporaryDirectories.push(root);
  const persistentPath = path.join(root, "workspace");
  await mkdir(persistentPath, { recursive: true });
  const txRoot = path.join(root, "tx");
  const manager = new FileSystemWorkspaceTransactionManager(txRoot);
  await manager.initialize();
  return { persistentPath, txRoot, manager };
}

describe("FileSystemWorkspaceTransactionManager — begin", () => {
  it("copies the persistent workspace into an isolated staging directory", async () => {
    const { persistentPath, manager } = await setup();
    await writeFile(path.join(persistentPath, "notes.txt"), "hello", "utf8");

    const handle = await manager.begin("agent-1", persistentPath);
    expect(handle.workingPath).not.toBe(persistentPath);
    await expect(readFile(path.join(handle.workingPath, "notes.txt"), "utf8")).resolves.toBe("hello");
  });

  it("reuses the same staging directory on a second begin (refine-in-place), without re-copying", async () => {
    const { persistentPath, manager } = await setup();
    await writeFile(path.join(persistentPath, "notes.txt"), "hello", "utf8");

    const first = await manager.begin("agent-1", persistentPath);
    await writeFile(path.join(first.workingPath, "draft.txt"), "in progress", "utf8");

    const second = await manager.begin("agent-1", persistentPath);
    expect(second.workingPath).toBe(first.workingPath);
    // The file written into staging after the first begin() must survive —
    // proof this was a resume, not a fresh copy that would have discarded it.
    await expect(readFile(path.join(second.workingPath, "draft.txt"), "utf8")).resolves.toBe("in progress");
  });

  it("excludes node_modules from the staged copy (Docker-symlink EACCES regression)", async () => {
    const { persistentPath, manager } = await setup();
    await mkdir(path.join(persistentPath, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(persistentPath, "node_modules", ".bin", "tool"), "x", "utf8");
    await writeFile(path.join(persistentPath, "app.js"), "console.log(1)", "utf8");

    const handle = await manager.begin("agent-1", persistentPath);
    const entries = await readdir(handle.workingPath);
    expect(entries).toContain("app.js");
    expect(entries).not.toContain("node_modules");
  });
});

describe("FileSystemWorkspaceTransactionManager — diffChanges", () => {
  it("reports created, modified, and deleted files", async () => {
    const { persistentPath, manager } = await setup();
    await writeFile(path.join(persistentPath, "keep.txt"), "same content", "utf8");
    await writeFile(path.join(persistentPath, "edit.txt"), "before", "utf8");
    await writeFile(path.join(persistentPath, "remove.txt"), "goodbye", "utf8");

    const handle = await manager.begin("agent-1", persistentPath);
    await writeFile(path.join(handle.workingPath, "edit.txt"), "after", "utf8");
    await rm(path.join(handle.workingPath, "remove.txt"));
    await writeFile(path.join(handle.workingPath, "new.txt"), "brand new", "utf8");

    const { files } = await manager.diffChanges(handle);
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]));

    expect(byPath["keep.txt"]).toBeUndefined();
    expect(byPath["edit.txt"]).toMatchObject({ kind: "modified", isBinary: false });
    expect(byPath["edit.txt"]?.diff?.some((line) => line.removed && line.value.includes("before"))).toBe(true);
    expect(byPath["edit.txt"]?.diff?.some((line) => line.added && line.value.includes("after"))).toBe(true);
    expect(byPath["remove.txt"]).toMatchObject({ kind: "deleted", contentBefore: "goodbye", sizeAfter: null });
    expect(byPath["new.txt"]).toMatchObject({ kind: "created", contentAfter: "brand new", sizeBefore: null });
  });

  it("reports a modified same-length file as changed (byte comparison, not just size)", async () => {
    const { persistentPath, manager } = await setup();
    await writeFile(path.join(persistentPath, "same-length.txt"), "aaaa", "utf8");
    const handle = await manager.begin("agent-1", persistentPath);
    await writeFile(path.join(handle.workingPath, "same-length.txt"), "bbbb", "utf8");

    const { files } = await manager.diffChanges(handle);
    expect(files.find((file) => file.path === "same-length.txt")).toMatchObject({ kind: "modified" });
  });

  it("marks a binary file as changed without attempting to diff its content", async () => {
    const { persistentPath, manager } = await setup();
    const handle = await manager.begin("agent-1", persistentPath);
    await writeFile(path.join(handle.workingPath, "image.bin"), Buffer.from([0x00, 0x01, 0xff, 0x00]));

    const { files } = await manager.diffChanges(handle);
    const file = files.find((item) => item.path === "image.bin");
    expect(file).toMatchObject({ kind: "created", isBinary: true, sizeBefore: null });
    expect(file?.diff).toBeUndefined();
    expect(file?.contentAfter).toBeUndefined();
  });

  it("reports no changes when the staged copy is untouched", async () => {
    const { persistentPath, manager } = await setup();
    await writeFile(path.join(persistentPath, "notes.txt"), "hello", "utf8");
    const handle = await manager.begin("agent-1", persistentPath);

    const { files } = await manager.diffChanges(handle);
    expect(files).toEqual([]);
  });
});

describe("FileSystemWorkspaceTransactionManager — commit", () => {
  it("swaps the staged copy into the persistent workspace's place", async () => {
    const { persistentPath, manager } = await setup();
    await writeFile(path.join(persistentPath, "notes.txt"), "before", "utf8");
    const handle = await manager.begin("agent-1", persistentPath);
    await writeFile(path.join(handle.workingPath, "notes.txt"), "after", "utf8");

    await manager.commit(handle);

    await expect(readFile(path.join(persistentPath, "notes.txt"), "utf8")).resolves.toBe("after");
    expect(await manager.hasActive("agent-1")).toBe(false);
  });

  it("carries a pre-existing node_modules forward untouched on commit", async () => {
    const { persistentPath, manager } = await setup();
    await mkdir(path.join(persistentPath, "node_modules"), { recursive: true });
    await writeFile(path.join(persistentPath, "node_modules", "marker.txt"), "installed", "utf8");
    await writeFile(path.join(persistentPath, "app.js"), "v1", "utf8");

    const handle = await manager.begin("agent-1", persistentPath);
    await writeFile(path.join(handle.workingPath, "app.js"), "v2", "utf8");
    await manager.commit(handle);

    await expect(readFile(path.join(persistentPath, "app.js"), "utf8")).resolves.toBe("v2");
    await expect(readFile(path.join(persistentPath, "node_modules", "marker.txt"), "utf8")).resolves.toBe(
      "installed",
    );
  });
});

describe("FileSystemWorkspaceTransactionManager — rollback", () => {
  it("discards the staged copy without touching the persistent workspace", async () => {
    const { persistentPath, manager } = await setup();
    await writeFile(path.join(persistentPath, "notes.txt"), "original", "utf8");
    const handle = await manager.begin("agent-1", persistentPath);
    await writeFile(path.join(handle.workingPath, "notes.txt"), "should never land", "utf8");

    await manager.rollback(handle);

    await expect(readFile(path.join(persistentPath, "notes.txt"), "utf8")).resolves.toBe("original");
    expect(await manager.hasActive("agent-1")).toBe(false);
  });
});

describe("FileSystemWorkspaceTransactionManager — hasActive / cleanupStale", () => {
  it("hasActive is false before begin and true after", async () => {
    const { persistentPath, manager } = await setup();
    expect(await manager.hasActive("agent-1")).toBe(false);
    await manager.begin("agent-1", persistentPath);
    expect(await manager.hasActive("agent-1")).toBe(true);
  });

  it("cleanupStale removes every leftover staging directory", async () => {
    const { persistentPath, manager } = await setup();
    await manager.begin("agent-1", persistentPath);
    await manager.begin("agent-2", persistentPath);

    const removed = await manager.cleanupStale();
    expect(removed).toBe(2);
    expect(await manager.hasActive("agent-1")).toBe(false);
    expect(await manager.hasActive("agent-2")).toBe(false);
  });
});
