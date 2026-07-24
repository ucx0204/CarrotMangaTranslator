import { beforeEach, describe, expect, it } from "vitest";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  createShareImportTrashService,
  type ShareImportTrashDependencies,
  type ShareImportTrashStorage,
  type TrashedChapterDirectory,
} from "../src/main/libraryStore/shareImportTrash";

type StorageCall =
  | { kind: "ensure"; path: string }
  | { kind: "move"; sourcePath: string; destinationPath: string }
  | { kind: "remove-tree"; path: string }
  | { kind: "remove-empty"; path: string };

class FakeTrashStorage implements ShareImportTrashStorage {
  readonly existingPaths = new Set<string>();
  readonly calls: StorageCall[] = [];
  readonly moveFailures = new Map<string, Error>();
  readonly removeEmptyFailures: Error[] = [];

  exists(path: string): boolean {
    return this.existingPaths.has(path);
  }

  async ensureDirectory(path: string): Promise<void> {
    this.calls.push({ kind: "ensure", path });
    this.existingPaths.add(path);
  }

  async move(sourcePath: string, destinationPath: string): Promise<void> {
    this.calls.push({ kind: "move", sourcePath, destinationPath });
    const failure = this.moveFailures.get(sourcePath);
    if (failure) {
      throw failure;
    }
    this.existingPaths.delete(sourcePath);
    this.existingPaths.add(destinationPath);
  }

  async removeDirectoryTree(path: string): Promise<void> {
    this.calls.push({ kind: "remove-tree", path });
    for (const existingPath of this.existingPaths) {
      if (existingPath === path || pathContains(path, existingPath)) {
        this.existingPaths.delete(existingPath);
      }
    }
  }

  async removeEmptyDirectory(path: string): Promise<void> {
    this.calls.push({ kind: "remove-empty", path });
    const failure = this.removeEmptyFailures.shift();
    if (failure) {
      throw failure;
    }
    this.existingPaths.delete(path);
  }
}

const worksRoot = resolve("C:/library/works");
const operationId = "operation-1";
let storage: FakeTrashStorage;
let dependencies: ShareImportTrashDependencies;

function pathContains(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath);
  return (
    child === "" || (!!child && !child.startsWith("..") && !isAbsolute(child))
  );
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function chapterDirectory(chapterId: string): string {
  return resolve(join(worksRoot, "work-1", "chapters", chapterId));
}

function trashedChapter(chapterId = "chapter-a"): TrashedChapterDirectory {
  const operationTrashRoot = resolve(
    join(worksRoot, "work-1", "chapters", ".trash", operationId),
  );
  return {
    chapterId,
    sourceDir: chapterDirectory(chapterId),
    trashDir: resolve(join(operationTrashRoot, chapterId)),
    operationTrashRoot,
  };
}

describe("share import trash service", () => {
  beforeEach(() => {
    storage = new FakeTrashStorage();
    dependencies = {
      paths: {
        getWorksRoot: () => worksRoot,
        isPathInside: pathContains,
      },
      storage,
      localization: {
        translate: (key) => `translated:${key}`,
      },
      createOperationId: () => operationId,
    };
  });

  it("moves only omitted existing chapters and records their exact locations", async () => {
    const omitted = trashedChapter();
    storage.existingPaths.add(omitted.sourceDir);
    storage.existingPaths.add(chapterDirectory("chapter-kept"));
    const service = createShareImportTrashService(dependencies);

    const result = await service.moveOmittedExistingChaptersToTrash(
      "work-1",
      ["chapter-a", "chapter-kept", "chapter-missing"],
      ["chapter-kept"],
    );

    expect(result).toEqual([omitted]);
    expect(storage.existingPaths.has(omitted.sourceDir)).toBe(false);
    expect(storage.existingPaths.has(omitted.trashDir)).toBe(true);
    expect(storage.calls).toEqual([
      { kind: "ensure", path: omitted.operationTrashRoot },
      {
        kind: "move",
        sourcePath: omitted.sourceDir,
        destinationPath: omitted.trashDir,
      },
    ]);
  });

  it("restores in reverse order and prunes only its own trash roots", async () => {
    const first = trashedChapter("chapter-a");
    const second = trashedChapter("chapter-b");
    storage.existingPaths.add(first.trashDir);
    storage.existingPaths.add(second.trashDir);
    const service = createShareImportTrashService(dependencies);

    await service.restoreTrashedChapterDirectories("work-1", [first, second]);

    const moveCalls = storage.calls.filter((call) => call.kind === "move");
    expect(moveCalls).toEqual([
      {
        kind: "move",
        sourcePath: second.trashDir,
        destinationPath: second.sourceDir,
      },
      {
        kind: "move",
        sourcePath: first.trashDir,
        destinationPath: first.sourceDir,
      },
    ]);
    expect(storage.calls.slice(-2)).toEqual([
      { kind: "remove-empty", path: first.operationTrashRoot },
      {
        kind: "remove-empty",
        path: resolve(join(worksRoot, "work-1", "chapters", ".trash")),
      },
    ]);
  });

  it("discards each operation tree once before pruning the shared trash root", async () => {
    const trashed = trashedChapter();
    storage.existingPaths.add(trashed.trashDir);
    const service = createShareImportTrashService(dependencies);

    await service.discardTrashedChapterDirectories("work-1", [
      trashed,
      trashed,
    ]);

    expect(storage.calls).toEqual([
      { kind: "remove-tree", path: trashed.operationTrashRoot },
      {
        kind: "remove-empty",
        path: resolve(join(worksRoot, "work-1", "chapters", ".trash")),
      },
    ]);
    expect(storage.existingPaths.has(trashed.trashDir)).toBe(false);
  });

  it("rejects work and chapter traversal before any storage side effect", async () => {
    const service = createShareImportTrashService(dependencies);

    await expect(
      service.moveOmittedExistingChaptersToTrash(
        "../outside",
        ["chapter-a"],
        [],
      ),
    ).rejects.toThrow("translated:share.errors.invalidChapterLocation");
    await expect(
      service.moveOmittedExistingChaptersToTrash(
        "work-1",
        ["../../outside"],
        [],
      ),
    ).rejects.toThrow("translated:share.errors.invalidChapterLocation");

    expect(storage.calls).toEqual([]);
  });

  it("rejects forged restore and discard records before any storage side effect", async () => {
    const valid = trashedChapter();
    const forged = {
      ...valid,
      operationTrashRoot: resolve("C:/unrelated"),
      trashDir: resolve("C:/unrelated/chapter-a"),
    };
    storage.existingPaths.add(forged.trashDir);
    const service = createShareImportTrashService(dependencies);

    await expect(
      service.restoreTrashedChapterDirectories("work-1", [valid, forged]),
    ).rejects.toThrow("translated:share.errors.invalidTrashLocation");
    await expect(
      service.discardTrashedChapterDirectories("work-1", [forged]),
    ).rejects.toThrow("translated:share.errors.invalidTrashLocation");

    expect(storage.calls).toEqual([]);
    expect(storage.existingPaths.has(forged.trashDir)).toBe(true);
  });

  it("rolls back earlier moves when a later chapter move fails", async () => {
    const first = trashedChapter("chapter-a");
    const second = trashedChapter("chapter-b");
    storage.existingPaths.add(first.sourceDir);
    storage.existingPaths.add(second.sourceDir);
    storage.moveFailures.set(second.sourceDir, new Error("rename failed"));
    const service = createShareImportTrashService(dependencies);

    await expect(
      service.moveOmittedExistingChaptersToTrash(
        "work-1",
        ["chapter-a", "chapter-b"],
        [],
      ),
    ).rejects.toThrow("rename failed");

    expect(storage.existingPaths.has(first.sourceDir)).toBe(true);
    expect(storage.existingPaths.has(first.trashDir)).toBe(false);
    expect(storage.calls).toContainEqual({
      kind: "move",
      sourcePath: first.trashDir,
      destinationPath: first.sourceDir,
    });
  });

  it("surfaces both the move and rollback errors without hiding either", async () => {
    const first = trashedChapter("chapter-a");
    const second = trashedChapter("chapter-b");
    storage.existingPaths.add(first.sourceDir);
    storage.existingPaths.add(second.sourceDir);
    storage.moveFailures.set(second.sourceDir, new Error("move failed"));
    storage.moveFailures.set(first.trashDir, new Error("restore failed"));
    const service = createShareImportTrashService(dependencies);

    const failure = await service
      .moveOmittedExistingChaptersToTrash(
        "work-1",
        ["chapter-a", "chapter-b"],
        [],
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("AggregateError가 필요합니다.");
    }
    expect(failure.errors).toEqual([
      expect.objectContaining({ message: "move failed" }),
      expect.objectContaining({ message: "restore failed" }),
    ]);
  });

  it("allows only missing or non-empty directories during pruning", async () => {
    storage.removeEmptyFailures.push(errno("ENOENT"), errno("ENOTEMPTY"));
    const service = createShareImportTrashService(dependencies);

    await expect(
      service.restoreTrashedChapterDirectories("work-1", [trashedChapter()]),
    ).resolves.toBeUndefined();
    expect(
      storage.calls.filter((call) => call.kind === "remove-empty"),
    ).toHaveLength(2);
  });

  it("propagates unexpected pruning failures", async () => {
    storage.removeEmptyFailures.push(errno("EACCES"));
    const service = createShareImportTrashService(dependencies);

    await expect(
      service.restoreTrashedChapterDirectories("work-1", [trashedChapter()]),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(
      storage.calls.filter((call) => call.kind === "remove-empty"),
    ).toHaveLength(1);
  });
});
