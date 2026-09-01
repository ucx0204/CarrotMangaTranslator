import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import {
  MAX_SHARE_JSON_BYTES,
  openZipArchiveReader,
} from "../src/main/libraryStore/zipSafety";
import type { TranslationBlock } from "../src/shared/textTypes";

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

it("exports and previews a valid chapter larger than the generic JSON limit", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "manga-share-large-chapter-"));
  tempDirs.push(rootDir);
  const sourcePath = join(rootDir, "page.png");
  const outputPath = join(rootDir, "large-chapter.mgtshare");
  await writeFile(sourcePath, Buffer.from("tiny-image"));

  const chapterId = "large-chapter";
  const pageId = "large-page";
  const fixture = createScaleLibrary([chapterId]);
  const baseChapter = fixture.chapters.get(chapterId);
  if (!baseChapter) {
    throw new Error("Large chapter fixture is missing.");
  }
  const repeatedSource = "あ".repeat(8_000);
  const repeatedTranslation = "가".repeat(8_000);
  const blocks: TranslationBlock[] = Array.from(
    { length: 500 },
    (_, index) => ({
      id: `block-${index}`,
      type: "nonsolid",
      bbox: { x: 0, y: 0, w: 100, h: 100 },
      sourceText: repeatedSource,
      translatedText: repeatedTranslation,
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 16,
      lineHeight: 1.2,
      textAlign: "left",
      textColor: "#000000",
      backgroundColor: "#ffffff",
      opacity: 1,
    }),
  );
  const chapter: LibraryChapter = {
    ...baseChapter,
    pageOrder: [pageId],
    pages: [
      {
        id: pageId,
        name: "page.png",
        imagePath: sourcePath,
        width: 100,
        height: 100,
        blocks,
        blockOrder: blocks.map((block) => block.id),
        analysisStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const readers = {
    loadWork: vi.fn(async () => fixture.work),
    loadChapter: vi.fn(async (_workId: string, requestedChapterId: string) =>
      requestedChapterId === chapterId ? chapter : null,
    ),
    loadStyleGuide: vi.fn(async () => fixture.styleGuide),
  } satisfies WorkShareExportReaderPort;

  const result = await createWorkShareExporter(readers)({
    workId: fixture.work.id,
    chapterIds: [chapterId],
    outputPath,
  });

  expect(result).toMatchObject({ chapterCount: 1, pageCount: 1 });
  const archive = await openZipArchiveReader(outputPath, "공유 파일");
  try {
    expect(
      archive.entryMap.get(`chapters/${chapterId}/chapter.json`)?.header?.size,
    ).toBeGreaterThan(MAX_SHARE_JSON_BYTES);
  } finally {
    archive.close();
  }
  await expect(previewWorkShareImport(outputPath)).resolves.toMatchObject({
    chapters: [{ packageChapterId: chapterId, pageCount: 1 }],
  });
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
