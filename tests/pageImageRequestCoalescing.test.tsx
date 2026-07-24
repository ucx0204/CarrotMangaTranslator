/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobState } from "../src/shared/jobTypes";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useAppSessionDerivedState } from "../src/renderer/src/app/session/useAppSessionDerivedState";
import { usePageImageDataUrls } from "../src/renderer/src/hooks/usePageImageDataUrls";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("page image request coalescing", () => {
  it("deduplicates selected, original, and neighbor requests for one path", async () => {
    const imageRequest = deferred<string>();
    const getPageImageDataUrl = vi.fn(() => imageRequest.promise);
    installImageGateway(getPageImageDataUrl);
    const selectedPage = makePage("page-1", "shared.png");
    const { result, rerender } = renderHook(
      ({ neighbors }) =>
        usePageImageDataUrls({
          chapterId: "chapter-1",
          neighborTargets: neighbors,
          selectedPage,
          selectedPageImagePath: selectedPage.imagePath,
        }),
      {
        initialProps: {
          neighbors: [{ pageId: "page-2", imagePath: "shared.png" }],
        },
      },
    );

    await waitFor(() => expect(getPageImageDataUrl).toHaveBeenCalledTimes(1));
    rerender({
      neighbors: [{ pageId: "page-2", imagePath: "shared.png" }],
    });
    rerender({
      neighbors: [{ pageId: "page-2", imagePath: "shared.png" }],
    });
    expect(getPageImageDataUrl).toHaveBeenCalledTimes(1);

    await act(async () => {
      imageRequest.resolve("mgt-image://library/shared");
      await imageRequest.promise;
    });
    await waitFor(() =>
      expect(result.current.selectedPageImageDataUrl).toBe(
        "mgt-image://library/shared",
      ),
    );
  });

  it("keeps structurally unchanged neighbor targets referentially stable", async () => {
    installImageGateway(
      vi.fn(async (path: string) => `mgt-image://library/${path}`),
    );
    const imageRef = React.createRef<HTMLImageElement>();
    const initialChapter = makeChapter();
    const { result, rerender } = renderHook(
      ({ chapter }) =>
        useAppSessionDerivedState({
          currentChapter: chapter,
          imageRef,
          inpaintingTool: "none",
          jobState: IDLE_JOB,
          patternMaskStrokesByPage: {},
          peekOriginal: false,
          regionSelection: null,
          selectedBlockId: null,
          selectedBlockIds: [],
          selectedPageId: "page-2",
        }),
      { initialProps: { chapter: initialChapter } },
    );
    const firstTargets = result.current.neighborTargets;

    rerender({
      chapter: {
        ...initialChapter,
        pages: initialChapter.pages.map((page) =>
          page.id === "page-2"
            ? { ...page, updatedAt: "2026-01-02T00:00:00.000Z" }
            : page,
        ),
      },
    });
    expect(result.current.neighborTargets).toBe(firstTargets);

    rerender({
      chapter: {
        ...initialChapter,
        pages: initialChapter.pages.map((page) =>
          page.id === "page-3"
            ? { ...page, inpaintedImagePath: "page-3-clean.png" }
            : page,
        ),
      },
    });
    expect(result.current.neighborTargets).not.toBe(firstTargets);
    expect(result.current.neighborTargets[0]?.imagePath).toBe(
      "page-3-clean.png",
    );
  });

  it("decodes neighbor images instead of only prefetching their signed URLs", async () => {
    const decodedSources: string[] = [];
    class DecodingImage {
      decoding = "auto";
      src = "";

      async decode(): Promise<void> {
        decodedSources.push(this.src);
      }

      removeAttribute(): void {
        this.src = "";
      }
    }
    vi.stubGlobal("Image", DecodingImage);
    installImageGateway(
      vi.fn(async (path: string) => `mgt-image://library/${path}`),
    );
    const selectedPage = makePage("page-1", "page-1.png");

    renderHook(() =>
      usePageImageDataUrls({
        chapterId: "chapter-1",
        neighborTargets: [{ pageId: "page-2", imagePath: "page-2.png" }],
        selectedPage,
        selectedPageImagePath: selectedPage.imagePath,
      }),
    );

    await waitFor(() =>
      expect(decodedSources).toEqual(["mgt-image://library/page-2.png"]),
    );
  });

  it("keeps decoded neighbor images bounded and releases them on unmount", async () => {
    const instances: DecodingImage[] = [];
    class DecodingImage {
      decoding = "auto";
      src = "";

      constructor() {
        instances.push(this);
      }

      async decode(): Promise<void> {
        return undefined;
      }

      removeAttribute(): void {
        this.src = "";
      }
    }
    vi.stubGlobal("Image", DecodingImage);
    installImageGateway(
      vi.fn(async (path: string) => `mgt-image://library/${path}`),
    );
    const selectedPage = makePage("page-1", "page-1.png");
    const view = renderHook(
      ({ index }) =>
        usePageImageDataUrls({
          chapterId: "chapter-1",
          neighborTargets: [
            { pageId: `neighbor-${index}`, imagePath: `neighbor-${index}.png` },
          ],
          selectedPage,
          selectedPageImagePath: selectedPage.imagePath,
        }),
      { initialProps: { index: 0 } },
    );

    for (let index = 0; index < 6; index += 1) {
      view.rerender({ index });
      await waitFor(() => expect(instances).toHaveLength(index + 1));
    }
    expect(instances.slice(0, 2).every((image) => image.src === "")).toBe(true);
    expect(instances.slice(2).every((image) => image.src !== "")).toBe(true);

    view.unmount();
    expect(instances.every((image) => image.src === "")).toBe(true);
  });
});

const IDLE_JOB: JobState = {
  id: "idle",
  kind: "gemma-analysis",
  progressText: "",
  status: "idle",
};

function installImageGateway(
  getPageImageDataUrl: (path: string) => Promise<string>,
): void {
  Object.defineProperty(window, "mangaApi", {
    configurable: true,
    value: createTestMangaGatewayStub({ getPageImageDataUrl }),
  });
}

function makeChapter(): ChapterSnapshot {
  const pages = [
    makePage("page-1", "page-1.png"),
    makePage("page-2", "page-2.png"),
    makePage("page-3", "page-3.png"),
  ];
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "chapter-1",
    pageOrder: pages.map((page) => page.id),
    pages,
    sourceKind: "images",
    status: "idle",
    title: "chapter",
    updatedAt: "2026-01-01T00:00:00.000Z",
    workId: "work-1",
  };
}

function makePage(id: string, imagePath: string): MangaPage {
  return {
    analysisStatus: "completed",
    blocks: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    dataUrl: "",
    height: 1600,
    id,
    imagePath,
    name: `${id}.png`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    width: 1200,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise)
        throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    },
  };
}
