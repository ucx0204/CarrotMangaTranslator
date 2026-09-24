import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../src/shared/libraryTypes";
import {
  DEFAULT_RASTER_EXPORT_SETTINGS,
  type LinkedWorkspaceRegistryV1,
} from "../src/shared/linkedWorkspaceTypes";
import type { PageExportRenderSession } from "../src/main/pageExport";
import { LinkedWorkspaceSyncService } from "../src/main/linkedWorkspace/linkedWorkspaceSyncService";
import type {
  ReviewedOutputEffect,
  ReviewedOutputExecution,
  ReviewedOutputIntent,
  ReviewedOutputPreflight,
} from "../src/main/linkedWorkspace/linkedWorkspaceReviewedOutputTypes";

export const REVIEW_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const WORK_ID = "11111111-1111-4111-8111-111111111111";
const time = "2026-09-23T00:00:00.000Z";

export async function reviewedWorkspace(counts = [2], inpainting = true) {
  const directory = await mkdtemp(join(tmpdir(), "mgt-reviewed-output-"));
  const dataRoot = join(directory, "data");
  const output = join(directory, "approved");
  await mkdir(dataRoot);
  await mkdir(output);
  const chapters = counts.map((count, index) =>
    makeChapter(index, count, dataRoot, inpainting),
  );
  const library = makeLibrary(chapters);
  for (const chapter of chapters) {
    for (const page of chapter.pages) {
      await writeFile(page.imagePath, REVIEW_PNG);
      if (page.inpaintedImagePath)
        await writeFile(page.inpaintedImagePath, REVIEW_PNG);
      if (page.inpaintMaskPath)
        await writeFile(page.inpaintMaskPath, REVIEW_PNG);
    }
  }
  const renderPage = vi.fn(
    async (
      page: MangaPage,
      _options?: Parameters<PageExportRenderSession["renderPage"]>[1],
    ) => Buffer.from("native-render:" + page.id),
  );
  const close = vi.fn();
  const cancel = vi.fn();
  const createRenderer = vi.fn(async () => ({ renderPage, close, cancel }));
  const updatePagesAfterInpainting = vi.fn();
  const reportError = vi.fn();
  const service = new LinkedWorkspaceSyncService({
    dataRoot,
    jobs: { hasActive: false } as never,
    decodeImage: async () => null,
    getMainWindow: () => null,
    reportError,
    dependencies: {
      listLibrary: async () => structuredClone(library),
      openChapter: async (id) => {
        const chapter = chapters.find((chapter) => chapter.id === id);
        if (!chapter) throw new Error("missing fixture chapter");
        return structuredClone(chapter);
      },
      updatePagesAfterInpainting,
      createPageExportRenderSession: createRenderer,
    },
  });
  await service.initialize();
  for (const chapter of chapters) {
    await service.connect({
      workId: WORK_ID,
      chapterId: chapter.id,
      rootPath: output,
      output: { ...DEFAULT_RASTER_EXPORT_SETTINGS, destinationMode: "fixed" },
      enqueueExistingPages: false,
    });
  }
  const first = chapters[0];
  if (!first) throw new Error("missing fixture selection");
  const connectionId = service.getStatus(first.id).connectionId;
  if (!connectionId) throw new Error("missing fixture connection");
  const selection = {
    chapterId: first.id,
    connectionId,
    pageIds: first.pages.map((page) => page.id),
  };
  return {
    directory,
    dataRoot,
    output,
    service,
    chapters,
    library,
    selection,
    renderPage,
    createRenderer,
    close,
    cancel,
    updatePagesAfterInpainting,
    reportError,
    registry: async () =>
      JSON.parse(
        await readFile(join(dataRoot, "linked-workspaces.json"), "utf8"),
      ) as LinkedWorkspaceRegistryV1,
    queue: () => readFile(join(dataRoot, "linked-sync-queue.json"), "utf8"),
    dispose: async () => {
      await service.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export type ReviewedFixture = Awaited<ReturnType<typeof reviewedWorkspace>>;

export function reviewedExecution(
  overrides: Partial<ReviewedOutputExecution> = {},
) {
  const controller = new AbortController();
  const intents: ReviewedOutputIntent[] = [];
  const effects: ReviewedOutputEffect[] = [];
  const context: ReviewedOutputExecution = {
    signal: controller.signal,
    assertAuthorized: () => undefined,
    onIntent: async (intent) => {
      intents.push(structuredClone(intent));
    },
    onEffect: async (effect) => {
      effects.push(structuredClone(effect));
    },
    ...overrides,
  };
  return { controller, intents, effects, context };
}

export function reviewedTarget(review: ReviewedOutputPreflight) {
  return {
    chapterId: review.chapterId,
    connectionId: review.connectionId,
    pageIds: review.pageIds,
    selectionSnapshot: review.selectionSnapshot,
    destinationSnapshot: review.destinationSnapshot,
    sourceSnapshot: review.sourceSnapshot,
  };
}

function makeChapter(
  index: number,
  count: number,
  dataRoot: string,
  inpainting: boolean,
): ChapterSnapshot {
  const chapterId =
    "22222222-2222-4222-8222-" + String(index + 1).padStart(12, "0");
  const pages: MangaPage[] = Array.from({ length: count }, (_, number) => {
    const id =
      "33333333-3333-4333-8333-" +
      String(index * 100 + number + 1).padStart(12, "0");
    const name = "page-" + index + "-" + number + ".png";
    return {
      id,
      name,
      imagePath: join(dataRoot, name),
      sourceFileName: name,
      sourceRelativePath: "chapter-" + index + "/" + name,
      dataUrl: "",
      width: 1,
      height: 1,
      blocks: [],
      blockOrder: [],
      analysisStatus: "completed",
      createdAt: time,
      updatedAt: time,
      ...(inpainting
        ? {
            inpaintedImagePath: join(dataRoot, "cleaned-" + name),
            inpaintMaskPath: join(dataRoot, "mask-" + name),
            maskProvenance: "derived-diff" as const,
          }
        : {}),
    };
  });
  return {
    id: chapterId,
    workId: WORK_ID,
    title: "Chapter " + index,
    sourceKind: "folder",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: time,
    updatedAt: time,
  };
}

function makeLibrary(chapters: ChapterSnapshot[]): LibraryIndex {
  return {
    workOrder: [WORK_ID],
    works: [
      {
        id: WORK_ID,
        title: "Reviewed work",
        chapterOrder: chapters.map((chapter) => chapter.id),
        chapters: chapters.map((chapter) => ({
          id: chapter.id,
          workId: WORK_ID,
          title: chapter.title,
          status: chapter.status,
          pageCount: chapter.pages.length,
          createdAt: time,
          updatedAt: time,
        })),
        createdAt: time,
        updatedAt: time,
      },
    ],
  };
}
