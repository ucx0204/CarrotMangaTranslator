// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { UseInpaintingActionsOptions } from "../src/renderer/src/hooks/inpaintingActionTypes";
import { useExportPageImagesAction } from "../src/renderer/src/hooks/useExportPageImagesAction";
import type { JobState } from "../src/shared/jobTypes";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type { PageImageExportResult } from "../src/shared/pageImageExportTypes";

const exportPageImages = vi.fn();

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({ exportPageImages });
});

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("useExportPageImagesAction", () => {
  it("returns false for cancellation without reporting a failure", async () => {
    const state = createJobStateHarness();
    const pushStatus = vi.fn();
    const options = makeOptions(state.setJobState, pushStatus);
    let resolveExport!: (result: PageImageExportResult | null) => void;
    exportPageImages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve;
        }),
    );
    const { result } = renderHook(() => useExportPageImagesAction(options));

    await act(async () => {
      const request = result.current([{ chapterId: "chapter-1", mode: "all" }]);
      await vi.waitFor(() => expect(exportPageImages).toHaveBeenCalledOnce());
      resolveExport({ status: "cancelled" });
      await expect(request).resolves.toBe(false);
    });

    expect(state.current()).toEqual({
      id: "idle",
      kind: "page-export",
      status: "idle",
      progressText: "",
    });
    expect(state.setJobState).not.toHaveBeenCalled();
    expect(pushStatus).not.toHaveBeenCalled();
  });

  it("marks a real export failure with the page-export kind", async () => {
    const state = createJobStateHarness();
    const pushStatus = vi.fn();
    const options = makeOptions(state.setJobState, pushStatus);
    exportPageImages.mockRejectedValue(new Error("render failed"));
    const { result } = renderHook(() => useExportPageImagesAction(options));

    await act(async () => {
      await expect(
        result.current([{ chapterId: "chapter-1", mode: "all" }]),
      ).rejects.toThrow("render failed");
    });

    expect(state.current()).toMatchObject({
      id: "failed-export",
      kind: "page-export",
      status: "failed",
    });
    expect(pushStatus).toHaveBeenCalledOnce();
  });

  it("forwards the textless export option to the gateway", async () => {
    const state = createJobStateHarness();
    const options = makeOptions(state.setJobState, vi.fn());
    exportPageImages.mockResolvedValue({ status: "cancelled" });
    const { result } = renderHook(() => useExportPageImagesAction(options));

    await act(async () => {
      await result.current(
        [{ chapterId: "chapter-1", mode: "all" }],
        undefined,
        { omitText: true },
      );
    });

    expect(exportPageImages).toHaveBeenCalledWith({
      workId: "work-1",
      selections: [{ chapterId: "chapter-1", mode: "all" }],
      omitText: true,
    });
  });
});

function createJobStateHarness() {
  let current: JobState = {
    id: "idle",
    kind: "page-export",
    status: "idle",
    progressText: "",
  };
  return {
    current: () => current,
    setJobState: vi.fn((update: SetStateAction<JobState>) => {
      current = typeof update === "function" ? update(current) : update;
    }),
  };
}

function makeOptions(
  setJobState: UseInpaintingActionsOptions["setJobState"],
  pushStatus: UseInpaintingActionsOptions["pushStatus"],
): UseInpaintingActionsOptions {
  return {
    askConfirm: vi.fn(),
    clearPageImageCache: vi.fn(),
    clearRetouchHistory: vi.fn(),
    currentChapter: makeChapter(),
    dirty: false,
    jobActive: false,
    mergeLiveChapter: vi.fn(),
    patternMaskStrokes: [],
    pushStatus,
    refreshLibrary: vi.fn(),
    saveNow: vi.fn(),
    selectedPage: null,
    setFlowActive: vi.fn(),
    setInpaintingTool: vi.fn(),
    setJobState,
    setPatternMaskStrokesByPage: vi.fn(),
    setPeekOriginal: vi.fn(),
    setShowBlockChrome: vi.fn(),
    workspaceHistory: { recordImageEdit: vi.fn() },
  };
}

function makeChapter(): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: [],
    pages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
