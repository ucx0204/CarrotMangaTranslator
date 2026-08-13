import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LibraryChapter, LibraryWork } from "../src/shared/libraryTypes";
import { MAX_SHARE_CHAPTERS } from "../src/main/libraryStore/sharePackage";
import type { WorkStyleGuide } from "../src/shared/workContextTypes";
import {
  createWorkShareExporter,
  type WorkShareExportReaderPort,
} from "../src/main/libraryStore/shareExportWorkflow";
import { previewWorkShareImport } from "../src/main/libraryStore/shareWorkflow";

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

it("exports and previews all 2000 in-memory chapters through one real archive", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-share-export-scale-"));
  tempDirs.push(rootDir);
  const chapterIds = Array.from(
    { length: MAX_SHARE_CHAPTERS },
    (_, index) => `chapter-${String(index + 1).padStart(4, "0")}`,
  );
  const { work, chapters, styleGuide } = createScaleLibrary(chapterIds);
  const loadChapter = vi.fn(async (workId: string, chapterId: string) =>
    workId === work.id ? (chapters.get(chapterId) ?? null) : null,
  );
  const readers = {
    loadWork: vi.fn(async () => work),
    loadChapter,
    loadStyleGuide: vi.fn(async () => styleGuide),
  } satisfies WorkShareExportReaderPort;
  const exportWorkShareToFile = createWorkShareExporter(readers);
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
  expect(loadChapter.mock.calls.map(([, chapterId]) => chapterId)).toEqual(
    chapterIds,
  );
}, 120_000);

function createScaleLibrary(chapterIds: string[]): {
  work: LibraryWork;
  chapters: ReadonlyMap<string, LibraryChapter>;
  styleGuide: WorkStyleGuide;
} {
  const work: LibraryWork = {
    id: "scale-work",
    title: "2000 Chapter Work",
    chapterOrder: chapterIds,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const chapters = new Map(
    chapterIds.map((chapterId, index) => [
      chapterId,
      {
        id: chapterId,
        workId: work.id,
        title: `Chapter ${index + 1}`,
        sourceKind: "folder" as const,
        status: "idle" as const,
        pageOrder: [],
        pages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } satisfies LibraryChapter,
    ]),
  );
  return {
    work,
    chapters,
    styleGuide: {
      schemaVersion: 1,
      workId: work.id,
      glossary: [],
      characters: [],
      rules: {
        honorifics: "adapt",
        sfxMode: "translate",
        defaultTone: "natural_korean",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}
