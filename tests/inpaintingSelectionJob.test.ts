import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import type { InpaintingJobContext } from "../src/main/jobs/inpaintingJobTypes";
import type { MangaPage } from "../src/shared/libraryTypes";

const mocks = vi.hoisted(() => ({
  acquireEngine: vi.fn(),
  inpaintPatternPage: vi.fn(),
  openChapter: vi.fn(),
  releaseEngine: vi.fn(),
  updatePagesAfterInpainting: vi.fn(),
}));

vi.mock("../src/main/library", () => ({
  openChapter: mocks.openChapter,
  updatePagesAfterInpainting: mocks.updatePagesAfterInpainting,
}));
vi.mock("../src/main/inpainting", () => ({
  inpaintDrawnPatternPage: vi.fn(),
  inpaintPatternPage: mocks.inpaintPatternPage,
}));
vi.mock("../src/main/inpainting/inpaintingEnginePool", () => ({
  acquireInpaintingEngine: mocks.acquireEngine,
}));
vi.mock("../src/main/settingsStore", () => ({
  getAppSettings: vi.fn(async () => ({
    inpainting: { model: "flux-klein" },
  })),
}));
vi.mock("../src/main/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  writeLog: vi.fn(),
}));

const chapterAId = "11111111-1111-4111-8111-111111111111";
const chapterBId = "22222222-2222-4222-8222-222222222222";
const pageA1Id = "33333333-3333-4333-8333-333333333333";
const pageA2Id = "44444444-4444-4444-8444-444444444444";
const pageB1Id = "55555555-5555-4555-8555-555555555555";

describe("multi-chapter automatic inpainting jobs", () => {
  const chapters = new Map<string, ReturnType<typeof makeChapter>>();
  const send = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    chapters.clear();
    chapters.set(
      chapterAId,
      makeChapter(chapterAId, "work-a", [
        makePage(pageA1Id, "a-1.png"),
        makePage(pageA2Id, "a-2.png"),
      ]),
    );
    chapters.set(
      chapterBId,
      makeChapter(chapterBId, "work-a", [makePage(pageB1Id, "b-1.png")]),
    );
    mocks.openChapter.mockImplementation(async (chapterId: string) => {
      const chapter = chapters.get(chapterId);
      if (!chapter) {
        throw new Error("missing chapter");
      }
      return chapter;
    });
    mocks.updatePagesAfterInpainting.mockImplementation(
      async (chapterId: string, pages: MangaPage[]) => {
        const chapter = chapters.get(chapterId);
        if (!chapter) {
          throw new Error("missing chapter");
        }
        const updates = new Map(pages.map((page) => [page.id, page]));
        const saved = {
          ...chapter,
          pages: chapter.pages.map((page) => updates.get(page.id) ?? page),
        };
        chapters.set(chapterId, saved);
        return saved;
      },
    );
    mocks.inpaintPatternPage.mockImplementation(async (page: MangaPage) => ({
      page: { ...page, inpaintedImagePath: `${page.imagePath}.inpainted.png` },
      blocksErased: 1,
    }));
    mocks.acquireEngine.mockResolvedValue({
      engine: { model: "flux-klein" },
      release: mocks.releaseEngine,
    });
  });

  it("processes ordered selections with one engine lease and aggregate progress", async () => {
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const result = await startInpaintingJob(makeContext(send), {
      mode: "selection-pattern",
      workId: "work-a",
      selections: [
        {
          chapterId: chapterAId,
          mode: "page-set",
          pageIds: [pageA2Id, pageA1Id],
        },
        { chapterId: chapterBId, mode: "all" },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.chapter).toBeUndefined();
    expect(result.chapters?.map((chapter) => chapter.id)).toEqual([
      chapterAId,
      chapterBId,
    ]);
    expect(result.pagesChanged).toBe(3);
    expect(mocks.acquireEngine).toHaveBeenCalledTimes(1);
    expect(mocks.releaseEngine).toHaveBeenCalledTimes(1);
    expect(
      mocks.inpaintPatternPage.mock.calls.map(([page]) => page.name),
    ).toEqual(["a-1.png", "a-2.png", "b-1.png"]);

    const jobEvents = send.mock.calls.map((call) => call[1]);
    expect(jobEvents.at(-1)).toMatchObject({
      status: "completed",
      progressCurrent: 3,
      progressTotal: 3,
      pageTotal: 3,
    });
    expect(
      jobEvents
        .filter((event) => event.status === "running")
        .every((event) => event.progressTotal === 3 && event.pageTotal === 3),
    ).toBe(true);
  });

  it.each([
    {
      label: "duplicate chapters",
      selections: [
        { chapterId: chapterAId, mode: "all" as const },
        { chapterId: chapterAId, mode: "all" as const },
      ],
      error: /Duplicate chapter/,
    },
    {
      label: "duplicate pages",
      selections: [
        {
          chapterId: chapterAId,
          mode: "page-set" as const,
          pageIds: [pageA1Id, pageA1Id],
        },
      ],
      error: /Duplicate page/,
    },
    {
      label: "unknown pages",
      selections: [
        {
          chapterId: chapterAId,
          mode: "page-set" as const,
          pageIds: [pageB1Id],
        },
      ],
      error: /does not belong/,
    },
  ])(
    "rejects $label before acquiring an engine",
    async ({ selections, error }) => {
      const { startInpaintingJob } =
        await import("../src/main/jobs/inpaintingJobs");
      const result = await startInpaintingJob(makeContext(send), {
        mode: "selection-pattern",
        workId: "work-a",
        selections,
      });

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(error);
      expect(mocks.acquireEngine).not.toHaveBeenCalled();
      expect(mocks.inpaintPatternPage).not.toHaveBeenCalled();
    },
  );

  it("rejects selections spanning multiple works", async () => {
    chapters.set(
      chapterBId,
      makeChapter(chapterBId, "work-b", [makePage(pageB1Id, "b-1.png")]),
    );
    const { startInpaintingJob } =
      await import("../src/main/jobs/inpaintingJobs");
    const result = await startInpaintingJob(makeContext(send), {
      mode: "selection-pattern",
      workId: "work-a",
      selections: [
        { chapterId: chapterAId, mode: "all" },
        { chapterId: chapterBId, mode: "all" },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/same work/);
    expect(mocks.acquireEngine).not.toHaveBeenCalled();
  });
});

function makePage(id: string, name: string): MangaPage {
  return {
    id,
    name,
    imagePath: `C:\\library\\${name}`,
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 100,
    blocks: [{}] as MangaPage["blocks"],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChapter(id: string, workId: string, pages: MangaPage[]) {
  return {
    id,
    workId,
    title: id,
    sourceKind: "images" as const,
    status: "completed" as const,
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeContext(send: ReturnType<typeof vi.fn>): InpaintingJobContext {
  const mainWindow = { webContents: { send } } as unknown as BrowserWindow;
  return {
    appPaths: {} as InpaintingJobContext["appPaths"],
    jobs: new ActiveJobStore(),
    getMainWindow: () => mainWindow,
    decodeImage: async () => {
      throw new Error("decode fallback should not run");
    },
  };
}
