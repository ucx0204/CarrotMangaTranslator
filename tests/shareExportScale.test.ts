import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryChapter, LibraryWork } from "../src/shared/libraryTypes";
import { MAX_SHARE_CHAPTERS } from "../src/main/libraryStore/sharePackage";

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

it("exports and previews all 2000 chapters in manifest order", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-share-export-scale-"));
  tempDirs.push(rootDir);
  const chapterIds = Array.from(
    { length: MAX_SHARE_CHAPTERS },
    (_, index) => `chapter-${String(index + 1).padStart(4, "0")}`,
  );
  await seedScaleLibrary(rootDir, chapterIds);
  mockAppPaths(rootDir);

  const { exportWorkShareToFile } =
    await import("../src/main/libraryStore/shareExportWorkflow");
  const { previewWorkShareImport } =
    await import("../src/main/libraryStore/shareWorkflow");
  const outputPath = join(rootDir, "scale-2000.mgtshare");

  const result = await exportWorkShareToFile({
    workId: "scale-work",
    chapterIds,
    outputPath,
  });
  const preview = await previewWorkShareImport(outputPath);

  expect(result.chapterCount).toBe(MAX_SHARE_CHAPTERS);
  expect(result.pageCount).toBe(0);
  expect(preview.chapters).toHaveLength(MAX_SHARE_CHAPTERS);
  expect(preview.chapters[0]?.packageChapterId).toBe("chapter-0001");
  expect(preview.chapters.at(-1)?.packageChapterId).toBe("chapter-2000");
  expect(preview.chapters.map((chapter) => chapter.packageChapterId)).toEqual(
    chapterIds,
  );
}, 120_000);

async function seedScaleLibrary(
  rootDir: string,
  chapterIds: string[],
): Promise<void> {
  const work: LibraryWork = {
    id: "scale-work",
    title: "2000 Chapter Work",
    chapterOrder: chapterIds,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const workRoot = join(rootDir, "works", work.id);
  const chaptersRoot = join(workRoot, "chapters");
  await mkdir(chaptersRoot, { recursive: true });
  await writeJson(join(workRoot, "work.json"), work);

  const batchSize = 50;
  for (let offset = 0; offset < chapterIds.length; offset += batchSize) {
    const batch = chapterIds.slice(offset, offset + batchSize);
    await Promise.all(
      batch.map(async (chapterId, batchIndex) => {
        const index = offset + batchIndex;
        const chapter: LibraryChapter = {
          id: chapterId,
          workId: work.id,
          title: `Chapter ${index + 1}`,
          sourceKind: "folder",
          status: "idle",
          pageOrder: [],
          pages: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        const chapterRoot = join(chaptersRoot, chapterId);
        await mkdir(chapterRoot, { recursive: true });
        await writeJson(join(chapterRoot, "chapter.json"), chapter);
      }),
    );
  }
}

function mockAppPaths(rootDir: string): void {
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({
      isPackaged: false,
      repoRoot: rootDir,
      executableDir: rootDir,
      resourcesDir: rootDir,
      dataRoot: rootDir,
      settingsPath: join(rootDir, "settings.json"),
      libraryDir: rootDir,
      logsDir: join(rootDir, "logs"),
      logFile: join(rootDir, "logs", "app.log"),
      runtimeDir: join(rootDir, "runtime"),
      toolsDir: join(rootDir, "tools"),
      llamaRuntimeDir: join(rootDir, "tools", "llama"),
      llamaServerPath: join(rootDir, "tools", "llama", "llama-server.exe"),
    }),
  }));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
