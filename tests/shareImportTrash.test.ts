import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const fsState = vi.hoisted(() => ({
  rmCalls: [] as unknown[][],
  rmdirCalls: [] as unknown[][],
  rmdirErrors: [] as NodeJS.ErrnoException[],
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(async (...args: unknown[]) => {
    fsState.rmCalls.push(args);
  }),
  rmdir: vi.fn(async (...args: unknown[]) => {
    fsState.rmdirCalls.push(args);
    const error = fsState.rmdirErrors.shift();
    if (error) {
      throw error;
    }
  }),
}));

vi.mock("../src/main/libraryStore/libraryFiles", () => ({
  WORKS_ROOT: "C:/library/works",
}));

vi.mock("../src/main/libraryStore/localization", () => ({
  tMain: (key: string) => key,
}));

vi.mock("../src/main/libraryStore/storage", () => ({
  isPathInside: () => true,
}));

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function trashedChapter() {
  const operationTrashRoot = join(
    "C:/library/works",
    "work-1",
    "chapters",
    ".trash",
    "operation-1",
  );
  return {
    chapterId: "chapter-a",
    sourceDir: join("C:/library/works", "work-1", "chapters", "chapter-a"),
    trashDir: join(operationTrashRoot, "chapter-a"),
    operationTrashRoot,
  };
}

describe("share import trash cleanup", () => {
  beforeEach(() => {
    fsState.rmCalls = [];
    fsState.rmdirCalls = [];
    fsState.rmdirErrors = [];
    vi.clearAllMocks();
  });

  it("does not prune an operation directory after recursively discarding it", async () => {
    const { discardTrashedChapterDirectories } =
      await import("../src/main/libraryStore/shareImportTrash");
    const trashed = trashedChapter();

    await discardTrashedChapterDirectories("work-1", [trashed]);

    expect(fsState.rmCalls).toEqual([
      [trashed.operationTrashRoot, { recursive: true, force: true }],
    ]);
    expect(fsState.rmdirCalls).toEqual([
      [join("C:/library/works", "work-1", "chapters", ".trash")],
    ]);
  });

  it("allows only missing or non-empty directories during empty-dir pruning", async () => {
    fsState.rmdirErrors = [errno("ENOENT"), errno("ENOTEMPTY")];
    const { restoreTrashedChapterDirectories } =
      await import("../src/main/libraryStore/shareImportTrash");

    await expect(
      restoreTrashedChapterDirectories("work-1", [trashedChapter()]),
    ).resolves.toBeUndefined();

    expect(fsState.rmdirCalls).toHaveLength(2);
  });

  it("propagates unexpected empty-dir cleanup failures", async () => {
    fsState.rmdirErrors = [errno("EACCES")];
    const { restoreTrashedChapterDirectories } =
      await import("../src/main/libraryStore/shareImportTrash");

    await expect(
      restoreTrashedChapterDirectories("work-1", [trashedChapter()]),
    ).rejects.toMatchObject({ code: "EACCES" });

    expect(fsState.rmdirCalls).toHaveLength(1);
  });
});
