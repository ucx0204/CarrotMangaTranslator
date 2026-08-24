import { describe, expect, it } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import {
  isWorkspaceImageReadyForSelectedPage,
  resolveJobActive,
  resolveModalOpen,
  resolveNeighborImageTargets,
  resolveSelectedPage,
  resolveSessionModalState,
  resolveWorkspaceImageDataUrl,
} from "../src/renderer/src/app/session/appSessionSelectors";

describe("AppSession selectors", () => {
  it("returns null when there is no current chapter", () => {
    expect(resolveSelectedPage(null, "page-1")).toBeNull();
  });

  it("falls back to the first page when the selected page is missing", () => {
    const chapter = makeChapter([makePage("page-1"), makePage("page-2")]);

    expect(resolveSelectedPage(chapter, "missing")?.id).toBe("page-1");
  });

  it("returns null when a chapter has no pages", () => {
    expect(resolveSelectedPage(makeChapter([]), "page-1")).toBeNull();
  });

  it("resolves next and previous neighbor image targets around the selected page", () => {
    const pages = [
      makePage("page-1"),
      makePage("page-2", { inpaintedImagePath: "page-2-clean.png" }),
      makePage("page-3"),
    ];

    expect(resolveNeighborImageTargets(pages, pages[1])).toEqual([
      {
        pageId: "page-3",
        imagePath: "page-3.png",
        originalImagePath: "page-3.png",
      },
      {
        pageId: "page-1",
        imagePath: "page-1.png",
        originalImagePath: "page-1.png",
      },
    ]);
    expect(resolveNeighborImageTargets(pages, pages[0])).toEqual([
      {
        pageId: "page-2",
        imagePath: "page-2-clean.png",
        originalImagePath: "page-2.png",
      },
    ]);
  });
});

describe("AppSession workspace selectors", () => {
  it("uses the original image whenever peek is enabled and available", () => {
    const selectedPage = makePage("page-1", {
      inpaintedImagePath: "page-1-clean.png",
    });

    expect(
      resolveWorkspaceImageDataUrl({
        peekOriginal: true,
        selectedPage,
        selectedPageImageDataUrl: "clean-data",
        selectedPageOriginalImageDataUrl: "original-data",
      }),
    ).toEqual({
      imageDataUrl: "original-data",
      peekAvailable: true,
      showingOriginalPeek: true,
    });

    expect(
      resolveWorkspaceImageDataUrl({
        peekOriginal: true,
        selectedPage,
        selectedPageImageDataUrl: "clean-data",
        selectedPageOriginalImageDataUrl: "",
      }).imageDataUrl,
    ).toBe("clean-data");
  });

  it("requires the loaded workspace image to belong to the selected page", () => {
    const selectedPage = makePage("page-2");

    expect(
      isWorkspaceImageReadyForSelectedPage({
        selectedPage,
        workspaceImageDataUrl: "old-page-data",
        workspaceImagePageId: "page-1",
      }),
    ).toBe(false);
    expect(
      isWorkspaceImageReadyForSelectedPage({
        selectedPage,
        workspaceImageDataUrl: "page-2-data",
        workspaceImagePageId: "page-2",
      }),
    ).toBe(true);
  });

  it("treats any overlay, palette, or shortcut modal as blocking", () => {
    expect(resolveModalOpen([null, false, "rename-target"], false, false)).toBe(
      true,
    );
    expect(resolveModalOpen([false], true, false)).toBe(true);
    expect(resolveModalOpen([false], false, true)).toBe(true);
    expect(resolveModalOpen([null, false], false, false)).toBe(false);
  });

  it("marks only live job states as active", () => {
    expect(resolveJobActive("starting")).toBe(true);
    expect(resolveJobActive("running")).toBe(true);
    expect(resolveJobActive("cancelling")).toBe(true);
    expect(resolveJobActive("completed")).toBe(false);
    expect(resolveJobActive("idle")).toBe(false);
  });
});

describe("AppSession library drop modal selector", () => {
  it("allows a library drop only through the translation source modal", () => {
    expect(
      resolveSessionModalState({
        commandPaletteOpen: false,
        overlayModalValues: [],
        shortcutHelpOpen: false,
        translationSourceOpen: true,
      }),
    ).toEqual({
      dropImportModalBlocked: false,
      modalOpen: true,
      overlayModalsOpen: true,
    });
    expect(
      resolveSessionModalState({
        commandPaletteOpen: false,
        overlayModalValues: ["settings"],
        shortcutHelpOpen: false,
        translationSourceOpen: false,
      }).dropImportModalBlocked,
    ).toBe(true);
    expect(
      resolveSessionModalState({
        commandPaletteOpen: true,
        overlayModalValues: [],
        shortcutHelpOpen: false,
        translationSourceOpen: false,
      }).dropImportModalBlocked,
    ).toBe(true);
  });
});

function makeChapter(pages: MangaPage[]): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePage(id: string, overrides: Partial<MangaPage> = {}): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    dataUrl: "",
    width: 100,
    height: 120,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
