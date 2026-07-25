import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import { startAnalysisJob } from "../src/main/jobs/translationJobs";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { JobEvent } from "../src/shared/jobTypes";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

describe("translation job lifecycle", () => {
  it("emits the cancelled terminal event before clearing the active job", async () => {
    const chapter = makeChapter();
    const runtime: NonNullable<Parameters<typeof startAnalysisJob>[2]> = {
      resolvePagesForRun: vi.fn().mockResolvedValue({
        chapter,
        pages: chapter.pages,
      }),
      runResolvedAnalysisJob: vi
        .fn()
        .mockRejectedValue(new DOMException("Aborted", "AbortError")),
      handleAnalysisJobError: vi.fn(async ({ emit, id }) => {
        await Promise.resolve();
        emit({
          id,
          kind: "gemma-analysis",
          status: "cancelled",
          progressText: "작업이 취소됨",
          phase: "cancelled",
        });
        return { status: "cancelled" as const };
      }),
    };
    const terminalOrder: string[] = [];
    const jobs = new ActiveJobStore();
    const clearIfCurrent = jobs.clearIfCurrent.bind(jobs);
    vi.spyOn(jobs, "clearIfCurrent").mockImplementation((jobId) => {
      terminalOrder.push("clear");
      clearIfCurrent(jobId);
    });
    const mainWindow = makeJobEventWindow(jobs, terminalOrder);

    const result = await startAnalysisJob(
      {
        jobs,
        getMainWindow: () => mainWindow,
        decodeImage: vi.fn(),
      },
      { chapterId: chapter.id, runMode: "all" },
      runtime,
    );

    expect(result).toEqual({ status: "cancelled" });
    expect(terminalOrder).toEqual(["cancelled", "clear"]);
    expect(jobs.current).toBeNull();
  });
});

function makeJobEventWindow(
  jobs: ActiveJobStore,
  terminalOrder: string[],
): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (_channel: string, event: JobEvent) => {
        expect(jobs.hasActive).toBe(true);
        terminalOrder.push(event.status);
      },
    },
  } as BrowserWindow;
}

function makeChapter(): ChapterSnapshot {
  const page: MangaPage = {
    id: "page-1",
    name: "001.png",
    imagePath: "C:/001.png",
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "idle",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: [page.id],
    pages: [page],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}
