import { join } from "node:path";
import { vi } from "vitest";
import { McpWorkFileExportReviewSchema } from "../src/shared/mcpWorkFileExport";
import { McpTextExportReviewOutputSchema } from "../src/shared/mcpTextExchange";
import type { compositeOutputFixture } from "./mcpCompositeNativeOutputs.fixture";

export function compositeWorkFileReview(
  f: ReturnType<typeof compositeOutputFixture>,
) {
  return McpWorkFileExportReviewSchema.parse({
    workId: f.chapter.workId,
    chapterIds: [f.chapter.id],
    snapshot: "c".repeat(16),
    sourceSnapshot: "d".repeat(16),
    format: "mgtshare-v1",
    workTitle: "Saved work",
    chapterCount: 1,
    pageCount: f.chapter.pages.length,
    blockCount: 4,
    chapters: [
      {
        chapterId: f.chapter.id,
        title: f.chapter.title,
        pageCount: f.chapter.pages.length,
        blockCount: 4,
        processedPageCount: 2,
        pages: f.input.pages,
      },
    ],
    sourceImageBytes: 40,
    includesStyleGuide: true,
    entryCount: 6,
    outputLimitBytes: 134217728,
    expandedLimitBytes: 268435456,
    sizingChecked: "during-native-write",
    executionReserved: false,
    warnings: [],
  });
}

export function compositeTextReview(
  f: ReturnType<typeof compositeOutputFixture>,
) {
  return McpTextExportReviewOutputSchema.parse({
    binding: {
      kind: "text",
      workId: f.chapter.workId,
      chapterId: f.chapter.id,
      pages: f.input.pages,
      options: { format: "csv", includeBom: true },
      direction: "rtl",
      snapshot: "e".repeat(16),
    },
    bytes: 100,
    pageCount: 2,
    blockCount: 4,
    rowCount: 4,
    omissions: [],
    warnings: [],
    executionReserved: false,
  });
}

export async function compositeContextState(
  f: ReturnType<typeof compositeOutputFixture>,
  libraryDir: string,
  withMemory = false,
  firstMemoryPageId?: string,
) {
  await saveCompositeContext(f, libraryDir, withMemory, firstMemoryPageId);
  const { readMcpContextExchangeState } =
    await import("../src/main/mcp/mcpContextExchangeSource");
  const verified = vi.fn(async (verify: () => Promise<void>) => verify());
  const readContext = vi.fn(
    async (...args: Parameters<typeof readMcpContextExchangeState>) => {
      const state = await readMcpContextExchangeState(...args);
      return {
        ...state,
        verifySources: () => verified(state.verifySources),
      };
    },
  );
  const state = await readContext(
    {
      workId: f.chapter.workId,
      chapterId: f.chapter.id,
      scope: withMemory ? "guide-and-memory" : "guide",
    },
    () => {},
  );
  readContext.mockClear();
  return { ...state, readContext, verified };
}

async function saveCompositeContext(
  f: ReturnType<typeof compositeOutputFixture>,
  libraryDir: string,
  withMemory: boolean,
  firstMemoryPageId?: string,
) {
  const files = await import("../src/main/libraryStore/libraryFiles");
  const context = await import("../src/main/libraryStore/workContextFiles");
  await files.writeIndexFile({ workOrder: [f.chapter.workId] });
  await files.writeWorkFile({
    id: f.chapter.workId,
    title: f.saved.workTitle,
    chapterOrder: [f.chapter.id],
    readingDirection: "rtl",
    createdAt: f.chapter.createdAt,
    updatedAt: f.chapter.updatedAt,
  });
  const directory = join(
    libraryDir,
    "works",
    f.chapter.workId,
    "chapters",
    f.chapter.id,
    "pages",
  );
  await files.writeChapterFile({
    ...f.chapter,
    pages: f.chapter.pages.map((page) => {
      const { dataUrl: _dataUrl, ...stored } = structuredClone(page);
      for (const block of stored.blocks) delete block.generatedLettering;
      return {
        ...stored,
        imagePath: join(directory, `${page.id}.png`),
        inpaintedImagePath: undefined,
        inpaintMaskPath: undefined,
      };
    }),
  });
  await context.writeWorkStyleGuide(f.saved.styleGuide);
  await context.writeChapterStoryMemory({
    ...f.saved.storyMemory,
    workId: f.chapter.workId,
    chapterId: f.chapter.id,
    pages: withMemory
      ? f.chapter.pages.map((page, pageIndex) => ({
          pageId: pageIndex === 0 ? (firstMemoryPageId ?? page.id) : page.id,
          pageName: page.name,
          pageIndex,
          sourceDigest: "native source",
          translatedDigest: "native translation",
          summary: "Saved summary",
          updatedAt: f.saved.storyMemory.updatedAt,
        }))
      : [],
  });
}
