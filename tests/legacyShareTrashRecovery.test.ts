import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("legacy share import trash recovery", () => {
  it("restores referenced missing chapters and discards unreferenced legacy trash", async () => {
    const root = await createLibraryRoot();
    const workRoot = join(root, "works", "work-1");
    await writeWork(workRoot, ["chapter-a"]);
    const trashRoot = join(workRoot, "chapters", ".trash", "operation-1");
    await mkdir(join(trashRoot, "chapter-a"), { recursive: true });
    await mkdir(join(trashRoot, "chapter-b"), { recursive: true });
    await writeFile(
      join(trashRoot, "chapter-a", "sentinel.txt"),
      "restore",
      "utf8",
    );
    await writeFile(
      join(trashRoot, "chapter-b", "sentinel.txt"),
      "discard",
      "utf8",
    );
    const recovery = await loadRecovery(root);

    const result = await recovery.recoverLegacyShareImportTrash();

    expect(result).toEqual({ chaptersRestored: 1, chaptersDiscarded: 1 });
    expect(
      await readFile(
        join(workRoot, "chapters", "chapter-a", "sentinel.txt"),
        "utf8",
      ),
    ).toBe("restore");
    await expect(
      readFile(join(workRoot, "chapters", "chapter-b", "sentinel.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when both the referenced source and legacy trash directory exist", async () => {
    const root = await createLibraryRoot();
    const workRoot = join(root, "works", "work-1");
    await writeWork(workRoot, ["chapter-a"]);
    const source = join(workRoot, "chapters", "chapter-a");
    const trash = join(
      workRoot,
      "chapters",
      ".trash",
      "operation-1",
      "chapter-a",
    );
    await mkdir(source, { recursive: true });
    await mkdir(trash, { recursive: true });
    await writeFile(join(source, "source.txt"), "source", "utf8");
    await writeFile(join(trash, "trash.txt"), "trash", "utf8");
    const recovery = await loadRecovery(root);

    await expect(recovery.recoverLegacyShareImportTrash()).rejects.toThrow(
      /source와 trash가 모두 존재합니다/,
    );
    expect(await readFile(join(source, "source.txt"), "utf8")).toBe("source");
    expect(await readFile(join(trash, "trash.txt"), "utf8")).toBe("trash");
  });
});

async function createLibraryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "legacy-share-trash-"));
  tempDirs.push(root);
  await mkdir(join(root, "works"), { recursive: true });
  return root;
}

async function writeWork(
  workRoot: string,
  chapterOrder: string[],
): Promise<void> {
  await mkdir(join(workRoot, "chapters"), { recursive: true });
  await writeFile(
    join(workRoot, "work.json"),
    `${JSON.stringify(
      {
        id: "work-1",
        title: "Work",
        chapterOrder,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function loadRecovery(root: string) {
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({ libraryDir: root, logFile: join(root, "app.log") }),
  }));
  return import("../src/main/libraryStore/legacyShareTrashRecovery");
}
