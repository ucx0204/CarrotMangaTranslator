// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChapterSnapshot,
  LibraryWorkSummary,
  MangaPage,
} from "../src/shared/libraryTypes";

const gatewayMocks = vi.hoisted(() => ({
  getPageImageDataUrl: vi.fn<(imagePath: string) => Promise<string>>(),
  openChapter: vi.fn(),
}));

vi.mock("../src/renderer/src/api/mangaGateway", () => ({
  mangaGateway: gatewayMocks,
}));

import {
  PageThumb,
  type ObservePageThumbnail,
} from "../src/renderer/src/components/ChapterPickerTiles";
import { WorkPagePicker } from "../src/renderer/src/components/WorkPagePicker";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const TS = "2026-01-01T00:00:00.000Z";

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  readonly targets = new Set<Element>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.root = options.root ?? null;
    this.rootMargin = options.rootMargin ?? "0px";
    this.thresholds = Array.isArray(options.threshold)
      ? options.threshold
      : [options.threshold ?? 0];
    observerInstances.push(this);
  }

  disconnect(): void {
    this.targets.clear();
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  intersect(...targets: Element[]): void {
    const entries = targets.map((target) => ({
      time: 0,
      target,
      rootBounds: null,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      isIntersecting: true,
      intersectionRatio: 1,
    }));
    this.callback(entries, this);
  }
}

const observerInstances: MockIntersectionObserver[] = [];

function makePage(
  index: number,
  imagePath = `C:/pages/${index}.png`,
): MangaPage {
  return {
    id: `page-${index}`,
    name: `${index}.png`,
    imagePath,
    dataUrl: "",
    width: 100,
    height: 150,
    blocks: [],
    analysisStatus: "idle",
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeChapter(pages: MangaPage[]): ChapterSnapshot {
  return {
    id: CHAPTER_ID,
    workId: WORK_ID,
    title: "1화",
    sourceKind: "zip",
    status: "idle",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeWork(pageCount: number): LibraryWorkSummary {
  return {
    id: WORK_ID,
    title: "대형 ZIP",
    chapterOrder: [CHAPTER_ID],
    chapters: [
      {
        id: CHAPTER_ID,
        workId: WORK_ID,
        title: "1화",
        status: "idle",
        pageCount,
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    createdAt: TS,
    updatedAt: TS,
  };
}

function pickerElement(
  pages: MangaPage[],
  onTogglePage = vi.fn(),
): React.JSX.Element {
  return (
    <WorkPagePicker
      work={makeWork(pages.length)}
      currentChapter={makeChapter(pages)}
      header={<h2>페이지 선택</h2>}
      getChapterTriState={() => "none"}
      getSelectedPageIds={() => new Set()}
      getChapterSummary={(_chapter, loadedPages) =>
        `${loadedPages?.length ?? pages.length}p`
      }
      renderSelectionSummary={() => null}
      onToggleChapter={vi.fn()}
      onTogglePage={onTogglePage}
    />
  );
}

const revealImmediately: ObservePageThumbnail = (_element, onVisible) => {
  onVisible();
  return () => undefined;
};

beforeEach(() => {
  observerInstances.length = 0;
  gatewayMocks.getPageImageDataUrl.mockImplementation((imagePath) =>
    Promise.resolve(`mgt-image://library/${encodeURIComponent(imagePath)}`),
  );
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("large WorkPagePicker thumbnails", () => {
  it("uses one list-rooted observer and only requests intersecting pages out of 2,000", async () => {
    const pages = Array.from({ length: 2_000 }, (_, index) =>
      makePage(index + 1),
    );
    const onTogglePage = vi.fn();
    const { container } = render(pickerElement(pages, onTogglePage));

    expect(observerInstances).toHaveLength(1);
    const observer = observerInstances[0];
    const pickerList = container.querySelector(".translate-picker-list");
    const frames = container.querySelectorAll(".translate-page-thumb-img");
    expect(observer.root).toBe(pickerList);
    expect(observer.rootMargin).toBe("300px 0px");
    expect(observer.thresholds).toEqual([0]);
    expect(observer.targets.size).toBe(2_000);
    expect(frames).toHaveLength(2_000);
    expect(gatewayMocks.getPageImageDataUrl).not.toHaveBeenCalled();

    await act(async () => {
      observer.intersect(frames[0], frames[1_999]);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(gatewayMocks.getPageImageDataUrl).toHaveBeenCalledTimes(2);
    });
    expect(gatewayMocks.getPageImageDataUrl).toHaveBeenNthCalledWith(
      1,
      pages[0].imagePath,
    );
    expect(gatewayMocks.getPageImageDataUrl).toHaveBeenNthCalledWith(
      2,
      pages[1_999].imagePath,
    );

    act(() => observer.intersect(frames[0], frames[1_999]));
    expect(gatewayMocks.getPageImageDataUrl).toHaveBeenCalledTimes(2);

    const lastPageLabel = screen.getByText("2000.png").closest("label");
    const lastPageCheckbox = lastPageLabel?.querySelector("input");
    if (!lastPageCheckbox) {
      throw new Error("last page checkbox was not rendered");
    }
    fireEvent.click(lastPageCheckbox);
    expect(onTogglePage).toHaveBeenCalledWith(CHAPTER_ID, "page-2000", pages);
  });

  it("falls back to immediate URL requests without IntersectionObserver", async () => {
    vi.unstubAllGlobals();
    const pages = [makePage(1), makePage(2)];
    render(pickerElement(pages));

    await waitFor(() => {
      expect(gatewayMocks.getPageImageDataUrl).toHaveBeenCalledTimes(2);
    });
  });
});

describe("PageThumb image states", () => {
  it("moves through idle, loading and loaded states", async () => {
    let reveal: (() => void) | undefined;
    const observe: ObservePageThumbnail = (_element, onVisible) => {
      reveal = onVisible;
      return () => undefined;
    };
    const { container } = render(
      <PageThumb
        page={makePage(1)}
        index={0}
        checked={false}
        observeThumbnail={observe}
        onToggle={vi.fn()}
      />,
    );
    const frame = container.querySelector(".translate-page-thumb-img");
    expect(frame?.getAttribute("data-image-state")).toBe("idle");

    act(() => reveal?.());
    expect(frame?.getAttribute("data-image-state")).toBe("loading");
    const image = await screen.findByAltText("1.png");
    fireEvent.load(image);
    expect(frame?.getAttribute("data-image-state")).toBe("loaded");
  });

  it("reissues once after an img error, then shows the localized failure tile", async () => {
    let issue = 0;
    gatewayMocks.getPageImageDataUrl.mockImplementation(() =>
      Promise.resolve(`mgt-image://library/retry-${++issue}`),
    );
    const page = makePage(1);
    const { container } = render(
      <PageThumb
        page={page}
        index={0}
        checked={false}
        observeThumbnail={revealImmediately}
        onToggle={vi.fn()}
      />,
    );

    const firstImage = await screen.findByAltText("1.png");
    expect(firstImage.getAttribute("src")).toContain("retry-1");
    fireEvent.error(firstImage);

    await waitFor(() => {
      expect(gatewayMocks.getPageImageDataUrl).toHaveBeenCalledTimes(2);
    });
    const secondImage = await screen.findByAltText("1.png");
    expect(secondImage.getAttribute("src")).toContain("retry-2");
    fireEvent.error(secondImage);

    expect(screen.getByRole("img", { name: "미리보기 실패" })).toBeTruthy();
    expect(
      container
        .querySelector(".translate-page-thumb-img")
        ?.getAttribute("data-image-state"),
    ).toBe("error");
    expect(gatewayMocks.getPageImageDataUrl).toHaveBeenCalledTimes(2);
  });

  it("shows failure without retrying when URL issuance rejects", async () => {
    const error = new Error("IPC failed");
    gatewayMocks.getPageImageDataUrl.mockRejectedValue(error);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(
      <PageThumb
        page={makePage(1)}
        index={0}
        checked={false}
        observeThumbnail={revealImmediately}
        onToggle={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("img", { name: "미리보기 실패" }),
    ).toBeTruthy();
    expect(gatewayMocks.getPageImageDataUrl).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(error);
  });

  it("ignores a late URL from the previous image path", async () => {
    let resolveOld: ((url: string) => void) | undefined;
    gatewayMocks.getPageImageDataUrl
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce("mgt-image://library/new");
    const firstPage = makePage(1, "C:/pages/old.png");
    const nextPage = { ...firstPage, imagePath: "C:/pages/new.png" };
    const { rerender } = render(
      <PageThumb
        page={firstPage}
        index={0}
        checked={false}
        observeThumbnail={revealImmediately}
        onToggle={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(gatewayMocks.getPageImageDataUrl).toHaveBeenCalledWith(
        firstPage.imagePath,
      );
    });

    rerender(
      <PageThumb
        page={nextPage}
        index={0}
        checked={false}
        observeThumbnail={revealImmediately}
        onToggle={vi.fn()}
      />,
    );
    const newImage = await screen.findByAltText("1.png");
    expect(newImage.getAttribute("src")).toBe("mgt-image://library/new");

    await act(async () => {
      resolveOld?.("mgt-image://library/old");
      await Promise.resolve();
    });
    expect(screen.getByAltText("1.png").getAttribute("src")).toBe(
      "mgt-image://library/new",
    );
  });
});
