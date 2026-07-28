/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobState } from "../src/shared/jobTypes";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useAppSessionDerivedState } from "../src/renderer/src/app/session/useAppSessionDerivedState";
import { usePageImageDataUrls } from "../src/renderer/src/hooks/usePageImageDataUrls";

beforeEach(() => {
  vi.stubGlobal("Image", ImmediateDecodingImage);
});

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

  it("keeps the current same-page frame until an invalidated replacement finishes decoding", async () => {
    const replacementRequest = deferred<string>();
    const replacementDecode = deferred<void>();
    const decodedSources: string[] = [];
    class ControlledDecodingImage {
      decoding = "auto";
      src = "";

      async decode(): Promise<void> {
        decodedSources.push(this.src);
        if (this.src === "mgt-image://library/page-1-retouched.png") {
          await replacementDecode.promise;
        }
      }

      removeAttribute(): void {
        this.src = "";
      }
    }
    vi.stubGlobal("Image", ControlledDecodingImage);
    const getPageImageDataUrl = vi.fn((path: string) =>
      path === "page-1-retouched.png"
        ? replacementRequest.promise
        : Promise.resolve(`mgt-image://library/${path}`),
    );
    installImageGateway(getPageImageDataUrl);
    const originalPage = makePage("page-1", "page-1.png");
    const initialPage = {
      ...originalPage,
      inpaintedImagePath: "page-1-inpainted.png",
    };
    const view = renderHook(
      ({ page }) =>
        usePageImageDataUrls({
          chapterId: "chapter-1",
          selectedPage: page,
          selectedPageImagePath: page.inpaintedImagePath ?? page.imagePath,
        }),
      { initialProps: { page: initialPage } },
    );

    await waitFor(() =>
      expect(view.result.current.selectedPageImageDataUrl).toBe(
        "mgt-image://library/page-1-inpainted.png",
      ),
    );
    act(() => view.result.current.clearPageImageCache());
    expect(view.result.current.selectedPageImageDataUrl).toBe(
      "mgt-image://library/page-1-inpainted.png",
    );

    view.rerender({
      page: {
        ...initialPage,
        inpaintedImagePath: "page-1-retouched.png",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });
    await waitFor(() =>
      expect(getPageImageDataUrl).toHaveBeenCalledWith("page-1-retouched.png"),
    );
    await act(async () => {
      replacementRequest.resolve("mgt-image://library/page-1-retouched.png");
      await replacementRequest.promise;
    });
    await waitFor(() =>
      expect(decodedSources).toContain(
        "mgt-image://library/page-1-retouched.png",
      ),
    );
    expect(view.result.current.selectedPageImageDataUrl).toBe(
      "mgt-image://library/page-1-inpainted.png",
    );

    await act(async () => {
      replacementDecode.resolve();
      await replacementDecode.promise;
    });
    await waitFor(() =>
      expect(view.result.current.selectedPageImageDataUrl).toBe(
        "mgt-image://library/page-1-retouched.png",
      ),
    );
  });

  it("keeps the previous decoded frame visible until the next page is ready", async () => {
    const secondPageRequest = deferred<string>();
    const getPageImageDataUrl = vi.fn((path: string) =>
      path === "page-2.png"
        ? secondPageRequest.promise
        : Promise.resolve(`mgt-image://library/${path}`),
    );
    installImageGateway(getPageImageDataUrl);
    const snapshots: Array<{
      dataUrl: string;
      loading: boolean;
      pageId: string;
      readyPageId: string | null;
    }> = [];
    const view = renderHook(
      ({ page }) => {
        const image = usePageImageDataUrls({
          chapterId: "chapter-1",
          selectedPage: page,
          selectedPageImagePath: page.imagePath,
        });
        snapshots.push({
          dataUrl: image.selectedPageImageDataUrl,
          loading: image.selectedPageImageLoading,
          pageId: page.id,
          readyPageId: image.selectedPageImageDataUrlPageId,
        });
        return image;
      },
      { initialProps: { page: makePage("page-1", "page-1.png") } },
    );
    await waitFor(() =>
      expect(view.result.current.selectedPageImageDataUrl).toBe(
        "mgt-image://library/page-1.png",
      ),
    );

    snapshots.length = 0;
    view.rerender({ page: makePage("page-2", "page-2.png") });

    const intermediatePageTwoRender = snapshots.find(
      (snapshot) => snapshot.pageId === "page-2",
    );
    expect(intermediatePageTwoRender).toEqual({
      dataUrl: "mgt-image://library/page-1.png",
      loading: true,
      pageId: "page-2",
      readyPageId: null,
    });

    await act(async () => {
      secondPageRequest.resolve("mgt-image://library/page-2.png");
      await secondPageRequest.promise;
    });
    await waitFor(() =>
      expect(view.result.current.selectedPageImageDataUrl).toBe(
        "mgt-image://library/page-2.png",
      ),
    );
    expect(view.result.current.selectedPageImageDataUrlPageId).toBe("page-2");
    expect(view.result.current.selectedPageImageLoading).toBe(false);
  });

  it("preserves the previous frame and stops loading when the next page fails", async () => {
    const secondPageRequest = deferred<string>();
    const error = new Error("page image failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    installImageGateway(
      vi.fn((path: string) =>
        path === "page-2.png"
          ? secondPageRequest.promise
          : Promise.resolve(`mgt-image://library/${path}`),
      ),
    );
    const view = renderHook(
      ({ page }) =>
        usePageImageDataUrls({
          chapterId: "chapter-1",
          selectedPage: page,
          selectedPageImagePath: page.imagePath,
        }),
      { initialProps: { page: makePage("page-1", "page-1.png") } },
    );
    await waitFor(() =>
      expect(view.result.current.selectedPageImageDataUrl).toBe(
        "mgt-image://library/page-1.png",
      ),
    );

    view.rerender({ page: makePage("page-2", "page-2.png") });
    expect(view.result.current.selectedPageImageDataUrl).toBe(
      "mgt-image://library/page-1.png",
    );
    expect(view.result.current.selectedPageImageLoading).toBe(true);

    await act(async () => {
      secondPageRequest.reject(error);
      await expect(secondPageRequest.promise).rejects.toBe(error);
    });
    await waitFor(() =>
      expect(view.result.current.selectedPageImageLoading).toBe(false),
    );
    expect(view.result.current.selectedPageImageDataUrl).toBe(
      "mgt-image://library/page-1.png",
    );
    expect(view.result.current.selectedPageImageDataUrlPageId).toBeNull();
    expect(consoleError).toHaveBeenCalledWith(error);
  });

  it("uses a decoded prefetched frame on the first render after switching pages", async () => {
    const decodedSources: string[] = [];
    class RecordingImage extends ImmediateDecodingImage {
      override async decode(): Promise<void> {
        decodedSources.push(this.src);
      }
    }
    vi.stubGlobal("Image", RecordingImage);
    installImageGateway(
      vi.fn(async (path: string) => `mgt-image://library/${path}`),
    );
    const snapshots: Array<{ dataUrl: string; pageId: string }> = [];
    const view = renderHook(
      ({ neighbors, page }) => {
        const image = usePageImageDataUrls({
          chapterId: "chapter-1",
          neighborTargets: neighbors,
          selectedPage: page,
          selectedPageImagePath: page.imagePath,
        });
        snapshots.push({
          dataUrl: image.selectedPageImageDataUrl,
          pageId: page.id,
        });
        return image;
      },
      {
        initialProps: {
          neighbors: [{ pageId: "page-2", imagePath: "page-2.png" }],
          page: makePage("page-1", "page-1.png"),
        },
      },
    );
    await waitFor(() => {
      expect(view.result.current.selectedPageImageDataUrl).toBe(
        "mgt-image://library/page-1.png",
      );
      expect(decodedSources).toContain("mgt-image://library/page-2.png");
    });
    await act(async () => {
      await Promise.resolve();
    });

    snapshots.length = 0;
    view.rerender({
      neighbors: [{ pageId: "page-1", imagePath: "page-1.png" }],
      page: makePage("page-2", "page-2.png"),
    });

    expect(snapshots[0]).toEqual({
      dataUrl: "mgt-image://library/page-2.png",
      pageId: "page-2",
    });
    expect(
      snapshots.every(
        (snapshot) =>
          snapshot.pageId !== "page-2" ||
          snapshot.dataUrl === "mgt-image://library/page-2.png",
      ),
    ).toBe(true);
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
      expect(decodedSources).toContain("mgt-image://library/page-2.png"),
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
      await waitFor(() => expect(instances).toHaveLength(index + 2));
    }
    expect(instances.slice(0, 3).every((image) => image.src === "")).toBe(true);
    expect(instances.slice(3).every((image) => image.src !== "")).toBe(true);

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
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject(reason) {
      if (!rejectPromise)
        throw new Error("Deferred promise was not initialized.");
      rejectPromise(reason);
    },
    resolve(value) {
      if (!resolvePromise)
        throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    },
  };
}

class ImmediateDecodingImage {
  decoding = "auto";
  src = "";

  async decode(): Promise<void> {
    return undefined;
  }

  removeAttribute(): void {
    this.src = "";
  }
}
