/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AppSidebar } from "../src/renderer/src/components/AppSidebar";
import { ImageStage } from "../src/renderer/src/components/ImageStage";
import { SoundEffectTranslationLauncher } from "../src/renderer/src/components/SoundEffectTranslationLauncher";
import { SoundEffectTranslationModal } from "../src/renderer/src/components/SoundEffectTranslationModal";
import { useSoundEffectTranslationModalState } from "../src/renderer/src/components/useSoundEffectTranslationModalState";
import {
  FontsContext,
  type FontsContextValue,
} from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { createWorkspaceInteractionPreviewStore } from "../src/renderer/src/lib/workspaceInteractionPreview";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../src/shared/libraryTypes";

const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
    }),
  });
});

afterEach(cleanup);

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
});

describe("sound-effect review UI", () => {
  it("keeps the generated SFX launcher outside the sidebar and chapter-scoped", () => {
    const onOpen = vi.fn();
    const { container, rerender } = render(
      <>
        <AppSidebar {...makeSidebarProps()} />
        <SoundEffectTranslationLauncher
          available={false}
          pendingCount={0}
          onOpen={onOpen}
        />
      </>,
    );
    expect(
      container.querySelector(".sidebar .sound-effect-translation-launcher"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /효과음 번역 실행/ }),
    ).toBeNull();

    rerender(
      <>
        <AppSidebar {...makeSidebarProps()} />
        <SoundEffectTranslationLauncher
          available
          pendingCount={0}
          onOpen={onOpen}
        />
      </>,
    );
    expect(
      screen.queryByRole("button", { name: /효과음 번역 실행/ }),
    ).toBeNull();

    rerender(
      <>
        <AppSidebar {...makeSidebarProps()} />
        <SoundEffectTranslationLauncher
          active
          available
          pendingCount={3}
          onOpen={onOpen}
        />
      </>,
    );
    const launcher = screen.getByRole("button", {
      name: "효과음 번역 실행, 대기 3개",
    });
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(launcher.className).toContain("is-active");
    expect(launcher.querySelector("img")?.getAttribute("src")).toContain(
      "sfx-script-icon.png",
    );
    expect(launcher.textContent).toContain("3");
    fireEvent.click(launcher);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("reviews full pages in-modal and starts only included SFX regions", () => {
    const onClose = vi.fn();
    const onStart = vi.fn();
    render(
      <SoundEffectTranslationModal
        chapter={makeChapter()}
        jobActive={false}
        onClose={onClose}
        onStart={onStart}
      />,
    );

    expect(screen.getByText("2개 페이지 · 후보 3개")).not.toBeNull();
    expect(screen.getByText("후보 3개 중 3개 포함")).not.toBeNull();
    const firstPage = screen.getByRole("button", {
      name: "001.png, 후보 2개 중 2개 포함",
    });
    const secondPage = screen.getByRole("button", {
      name: "003.png, 후보 1개 중 1개 포함",
    });
    const inpaint = screen.getByRole("switch", {
      name: "번역 후 원문 지우기(인페인팅)",
    });
    const autoFontMatching = screen.getByRole("switch", {
      name: "폰트 자동 맞춤",
    });
    expect(firstPage.getAttribute("aria-current")).toBe("page");
    expect(secondPage.getAttribute("aria-current")).toBeNull();
    expect(inpaint.getAttribute("aria-checked")).toBe("false");
    expect(autoFontMatching.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("002.png")).toBeNull();
    expect(
      document.querySelector('[data-preview-page-id="page-1"]'),
    ).not.toBeNull();
    const firstCandidate = screen.getByRole("button", {
      name: "효과음 후보 1, 포함: ドン",
    });
    expect(firstCandidate.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    expect(firstCandidate.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("후보 3개 중 0개 포함")).not.toBeNull();
    expect(
      (screen.getByRole("button", { name: "검토 완료" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    fireEvent.click(firstCandidate);
    expect(firstCandidate.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(firstCandidate);
    expect(firstCandidate.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("후보 3개 중 2개 포함")).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "003.png, 후보 1개 중 1개 포함",
      }),
    );
    expect(
      document.querySelector('[data-preview-page-id="page-3"]'),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "효과음 후보 1, 포함: 읽기 불확실",
      }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "페이지에서 검토" }),
    ).toBeNull();
    fireEvent.click(inpaint);
    fireEvent.click(autoFontMatching);

    fireEvent.click(
      screen.getByRole("button", { name: "선택한 효과음 2개 번역" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        chapterId: "chapter-1",
        pages: [
          expect.objectContaining({
            dismissedRegionIds: ["FX-left"],
            includedRegionIds: ["FX-right"],
            pageId: "page-1",
          }),
          expect.objectContaining({
            dismissedRegionIds: [],
            includedRegionIds: ["FX-third"],
            pageId: "page-3",
          }),
        ],
      }),
      true,
      true,
    );
  });

  it("confirms an all-excluded review without starting the translation model", () => {
    const onStart = vi.fn();
    render(
      <SoundEffectTranslationModal
        chapter={makeChapter()}
        jobActive={false}
        onClose={vi.fn()}
        onStart={onStart}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    fireEvent.click(screen.getByRole("button", { name: "검토 완료" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: [
          expect.objectContaining({
            includedRegionIds: [],
            dismissedRegionIds: ["FX-left", "FX-right"],
          }),
          expect.objectContaining({
            includedRegionIds: [],
            dismissedRegionIds: ["FX-third"],
          }),
        ],
      }),
      false,
      false,
    );
  });

  it("inherits the SFX-specific font-matching default", () => {
    render(
      <SoundEffectTranslationModal
        chapter={makeChapter()}
        jobActive={false}
        autoFontMatchingDefault
        onClose={vi.fn()}
        onStart={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("switch", { name: "폰트 자동 맞춤" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("persists only the two SFX execution defaults", () => {
    const onPersistDefaults = vi.fn();
    render(
      <SoundEffectTranslationModal
        chapter={makeChapter()}
        jobActive={false}
        onClose={vi.fn()}
        onPersistDefaults={onPersistDefaults}
        onStart={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "폰트 자동 맞춤" }));
    fireEvent.click(
      screen.getByRole("switch", {
        name: "번역 후 원문 지우기(인페인팅)",
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "다음 번역의 기본값으로 저장",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "선택한 효과음 3개 번역" }),
    );

    expect(onPersistDefaults).toHaveBeenCalledWith({
      sfxAutoFontMatchingDefault: true,
      sfxInpaintAfterTranslationDefault: true,
    });
  });

  it("shows every chapter page and existing translations only on demand", () => {
    const chapter = makeChapter();
    chapter.pages[0] = {
      ...chapter.pages[0],
      blocks: [
        {
          ...makeBlock("existing-translation", {
            x: 400,
            y: 300,
            w: 180,
            h: 90,
          }),
          opacity: 0.7,
          translatedText: "기존 번역문",
        },
      ],
    };
    render(
      <SoundEffectTranslationModal
        chapter={chapter}
        jobActive={false}
        onClose={vi.fn()}
        onStart={vi.fn()}
      />,
    );

    expect(screen.queryByText("002.png")).toBeNull();
    expect(screen.queryByText("기존 번역문")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "전체 페이지 표시" }));
    fireEvent.click(screen.getByRole("switch", { name: "번역문 표시" }));

    expect(screen.getByText("002.png")).not.toBeNull();
    expect(screen.getByText("기존 번역문")).not.toBeNull();
    const translationChrome = document.querySelector<HTMLElement>(
      ".overlay-block-chrome",
    );
    expect(translationChrome).not.toBeNull();
    expect(translationChrome?.style.borderColor).toBe("rgb(245, 158, 11)");
    expect(translationChrome?.style.backgroundColor).toBe(
      "rgba(254, 243, 199, 0.7)",
    );
  });

  it("moves and resizes a selected candidate without changing inclusion", () => {
    const onStart = vi.fn();
    render(
      <SoundEffectTranslationModal
        chapter={makeChapter()}
        jobActive={false}
        onClose={vi.fn()}
        onStart={onStart}
      />,
    );
    const candidate = screen.getByRole("button", {
      name: "효과음 후보 1, 포함: ドン",
    });

    fireEvent.click(candidate);
    expect(candidate.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("[data-resize-handle]")).toHaveLength(8);
    fireEvent.click(candidate);
    expect(candidate.getAttribute("aria-pressed")).toBe("false");
    expect(
      Array.from(document.querySelectorAll("[data-resize-handle]")).every(
        (handle) => handle.getAttribute("data-candidate-state") === "excluded",
      ),
    ).toBe(true);
    fireEvent.click(candidate);
    expect(candidate.getAttribute("aria-pressed")).toBe("true");

    fireEvent.pointerDown(candidate, {
      button: 0,
      clientX: 70,
      clientY: 70,
      pointerId: 3,
    });
    fireEvent.pointerMove(window, {
      clientX: 140,
      clientY: 140,
      pointerId: 3,
    });
    fireEvent.pointerUp(window, { pointerId: 3 });
    fireEvent.click(candidate);
    expect(candidate.getAttribute("aria-pressed")).toBe("true");

    const southeast = document.querySelector<HTMLElement>(
      '[data-resize-handle="se"]',
    );
    if (!southeast) throw new Error("Expected southeast resize handle.");
    fireEvent.pointerDown(southeast, {
      button: 0,
      clientX: 196,
      clientY: 224,
      pointerId: 4,
    });
    fireEvent.pointerMove(window, {
      clientX: 266,
      clientY: 294,
      pointerId: 4,
    });
    fireEvent.pointerUp(window, { pointerId: 4 });
    fireEvent.click(candidate);
    expect(candidate.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(candidate);
    expect(candidate.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "선택한 효과음 3개 번역" }),
    );
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: expect.arrayContaining([
          expect.objectContaining({
            editedRegions: [
              {
                regionId: "FX-left",
                bbox: { x: 200, y: 200, w: 180, h: 220 },
              },
            ],
            includedRegionIds: ["FX-left", "FX-right"],
          }),
        ]),
      }),
      false,
      false,
    );
  });

  it("selects on the first pointer click and toggles on the second", () => {
    render(
      <SoundEffectTranslationModal
        chapter={makeChapter()}
        jobActive={false}
        onClose={vi.fn()}
        onStart={vi.fn()}
      />,
    );
    const candidate = screen.getByRole("button", {
      name: "효과음 후보 1, 포함: ドン",
    });

    fireEvent.pointerDown(candidate, { button: 2, pointerId: 20 });
    expect(document.querySelectorAll("[data-resize-handle]")).toHaveLength(0);

    fireEvent.pointerDown(candidate, { button: 0, pointerId: 21 });
    fireEvent.pointerUp(window, { pointerId: 21 });
    fireEvent.click(candidate, { detail: 1 });
    expect(candidate.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("[data-resize-handle]")).toHaveLength(8);

    fireEvent.pointerDown(candidate, { button: 0, pointerId: 22 });
    fireEvent.pointerUp(window, { pointerId: 22 });
    fireEvent.click(candidate, { detail: 1 });
    expect(candidate.getAttribute("aria-pressed")).toBe("false");
  });

  it("creates a manual candidate on an empty page and deletes a selection with Esc", () => {
    const randomUuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("00000000-0000-4000-8000-000000000099");
    const onStart = vi.fn();
    render(
      <SoundEffectTranslationModal
        chapter={makeChapter()}
        jobActive={false}
        onClose={vi.fn()}
        onStart={onStart}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "전체 페이지 표시" }));
    fireEvent.click(
      screen.getByRole("button", { name: "002.png, 후보 0개 중 0개 포함" }),
    );
    const canvas = document.querySelector<HTMLElement>(
      '[data-preview-page-id="page-2"]',
    );
    if (!canvas) throw new Error("Expected empty-page preview canvas.");
    fireEvent.pointerDown(canvas, { button: 2, pointerId: 4 });
    expect(
      screen.queryByRole("button", {
        name: "효과음 후보 1, 포함: 읽기 불확실",
      }),
    ).toBeNull();
    fireEvent.pointerDown(canvas, {
      button: 0,
      clientX: 70,
      clientY: 70,
      pointerId: 5,
    });
    fireEvent.pointerMove(window, {
      clientX: 140,
      clientY: 140,
      pointerId: 5,
    });
    fireEvent.pointerUp(window, { pointerId: 5 });

    expect(
      screen.getByRole("button", {
        name: "효과음 후보 1, 포함: 읽기 불확실",
      }),
    ).not.toBeNull();
    expect(document.querySelectorAll("[data-resize-handle]")).toHaveLength(8);
    fireEvent.click(
      screen.getByRole("button", { name: "선택한 효과음 4개 번역" }),
    );
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: expect.arrayContaining([
          expect.objectContaining({
            pageId: "page-2",
            includedRegionIds: ["manual-00000000-0000-4000-8000-000000000099"],
            addedRegions: [
              {
                regionId: "manual-00000000-0000-4000-8000-000000000099",
                bbox: { x: 100, y: 100, w: 100, h: 100 },
              },
            ],
          }),
        ]),
      }),
      false,
      false,
    );
    randomUuid.mockRestore();
  });

  it("marks an existing selected candidate dismissed when Esc deletes it", () => {
    const onStart = vi.fn();
    render(
      <SoundEffectTranslationModal
        chapter={makeChapter()}
        jobActive={false}
        onClose={vi.fn()}
        onStart={onStart}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "효과음 후보 1, 포함: ドン" }),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("button", { name: /ドン/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "선택한 효과음 2개 번역" }),
    );
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        pages: expect.arrayContaining([
          expect.objectContaining({
            pageId: "page-1",
            dismissedRegionIds: ["FX-left"],
          }),
        ]),
      }),
      false,
      false,
    );
  });

  it.each(["Delete", "Backspace"])(
    "deletes a selected candidate with %s",
    (key) => {
      const onStart = vi.fn();
      render(
        <SoundEffectTranslationModal
          chapter={makeChapter()}
          jobActive={false}
          onClose={vi.fn()}
          onStart={onStart}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "효과음 후보 1, 포함: ドン" }),
      );
      fireEvent.keyDown(window, { key });

      expect(screen.queryByRole("button", { name: /ドン/ })).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "선택한 효과음 2개 번역" }),
      );
      expect(onStart).toHaveBeenCalledWith(
        expect.objectContaining({
          pages: expect.arrayContaining([
            expect.objectContaining({ dismissedRegionIds: ["FX-left"] }),
          ]),
        }),
        false,
        false,
      );
    },
  );

  it("handles inactive, unrelated, empty-selection, and editable keyboard paths", () => {
    const onClose = vi.fn();
    const onStart = vi.fn();
    const { result, rerender } = renderHook(
      ({ jobActive }: { jobActive: boolean }) =>
        useSoundEffectTranslationModalState({
          chapter: makeChapter(),
          jobActive,
          autoFontMatchingDefault: false,
          inpaintAfterTranslationDefault: false,
          onClose,
          onStart,
        }),
      { initialProps: { jobActive: true } },
    );

    act(() => result.current.start());
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onStart).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    rerender({ jobActive: false });
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(onClose).not.toHaveBeenCalled();

    const editableTargets = [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("select"),
      document.createElement("div"),
    ];
    editableTargets[3].contentEditable = "true";
    editableTargets.forEach((target) => {
      document.body.append(target);
      fireEvent.keyDown(target, { key: "Delete" });
      target.remove();
    });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the launcher useful after every candidate is resolved", () => {
    const chapter = makeChapter();
    chapter.pages = chapter.pages.map((page) => ({
      ...page,
      soundEffectReview: page.soundEffectReview
        ? {
            ...page.soundEffectReview,
            resolvedRegions: page.soundEffectReview.regions.map((region) => ({
              regionId: region.id,
              blockId: `block-${region.id}`,
              resolvedAt: TS,
            })),
          }
        : undefined,
    }));
    render(
      <SoundEffectTranslationModal
        chapter={chapter}
        jobActive={false}
        onClose={vi.fn()}
        onStart={vi.fn()}
      />,
    );
    expect(screen.getByText("대기 중인 효과음이 없습니다.")).not.toBeNull();
  });

  it("uses batch-first review actions and Esc closes popup before the layer", () => {
    const page = makeReviewPage("page-1", "001.png", ["FX-left", "FX-right"]);
    const baseProps = makeImageStageProps(page);
    const onDismiss = vi.fn();
    const onExit = vi.fn();
    const onOpenBatch = vi.fn();
    const onSelect = vi.fn();
    const onTranslate = vi.fn();
    const renderStage = (
      overrides: Partial<React.ComponentProps<typeof ImageStage>>,
    ) => (
      <FontsContext.Provider value={FONTS_CONTEXT}>
        <ImageStage {...baseProps} {...overrides} />
      </FontsContext.Provider>
    );
    const completeHandlers = {
      onDismissSoundEffectReviewRegion: onDismiss,
      onExitSoundEffectReview: onExit,
      onOpenSoundEffectTranslation: onOpenBatch,
      onSelectSoundEffectReviewRegion: onSelect,
      onTranslateSoundEffectReviewRegion: onTranslate,
    };
    const { container, rerender } = render(
      renderStage({ showSoundEffectReview: true }),
    );
    expect(
      container.querySelector("[data-sound-effect-review-layer]"),
    ).toBeNull();

    rerender(
      renderStage({
        ...completeHandlers,
        selectedSoundEffectReviewRegionId: "FX-right",
        showSoundEffectReview: true,
      }),
    );
    const rightRegion = screen.getByRole("button", {
      name: "효과음 검토 후보 2: 읽기 불확실",
    });
    expect(rightRegion.getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerDown(rightRegion);
    expect(baseProps.onStagePointerDown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "효과음 전체 번역" }));
    fireEvent.click(screen.getByRole("button", { name: "이 영역만 번역" }));
    fireEvent.click(screen.getByRole("button", { name: "검토 대상에서 제외" }));
    expect(onOpenBatch).toHaveBeenCalledOnce();
    expect(onTranslate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FX-right" }),
    );
    expect(onDismiss).toHaveBeenCalledWith("FX-right");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onSelect).toHaveBeenCalledWith(null);
    expect(onExit).not.toHaveBeenCalled();

    rerender(
      renderStage({
        ...completeHandlers,
        selectedSoundEffectReviewRegionId: null,
        showSoundEffectReview: true,
      }),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onExit).toHaveBeenCalledOnce();
  });
});

const TS = "2026-09-01T00:00:00.000Z";
const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function makeChapter(): ChapterSnapshot {
  const currentWithoutCandidates = makeReviewPage("page-2", "002.png", []);
  currentWithoutCandidates.soundEffectReview = undefined;
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pages: [
      makeReviewPage("page-1", "001.png", ["FX-left", "FX-right"]),
      currentWithoutCandidates,
      makeReviewPage("page-3", "003.png", ["FX-third"]),
    ],
    pageOrder: ["page-1", "page-2", "page-3"],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeReviewPage(
  id: string,
  name: string,
  regionIds: string[],
): MangaPage {
  return {
    id,
    name,
    imagePath: `C:/qa/${name}`,
    dataUrl: PIXEL,
    width: 1000,
    height: 1000,
    blocks: [],
    soundEffectReview: {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regionOverrides: [],
      manualRegions: [],
      resolvedRegions: [],
      regions: regionIds.map((regionId, index) => ({
        id: regionId,
        bbox:
          index === 0
            ? { x: 100, y: 100, w: 80, h: 120 }
            : { x: 850, y: 850, w: 100, h: 100 },
        detectorConfidence: 0.9 - index * 0.1,
        ...(regionId === "FX-left" ? { recognizedText: "ドン" } : {}),
      })),
    },
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeImageStageProps(
  page: MangaPage,
): React.ComponentProps<typeof ImageStage> {
  return {
    imageDataUrl: PIXEL,
    imageRef: React.createRef<HTMLImageElement>(),
    interactionPreviewStore: createWorkspaceInteractionPreviewStore(),
    onBlockPointerDown: vi.fn(),
    onStagePointerDown: vi.fn(),
    onStagePointerLeave: vi.fn(),
    onStagePointerMove: vi.fn(),
    onStagePointerUp: vi.fn(),
    page,
    regionSelectionActive: false,
    regionSelectionRect: null,
    selectedBlockId: null,
    selectedBlockIds: [],
    showBlockChrome: false,
    showTextBlocks: false,
    stageRef: React.createRef<HTMLDivElement>(),
    stageSize: { width: 100, height: 100 },
    textLayoutStageSize: { width: 100, height: 100 },
  };
}

function makeBlock(
  id: string,
  bbox: MangaPage["blocks"][number]["bbox"],
): MangaPage["blocks"][number] {
  return {
    id,
    type: "nonsolid",
    bbox,
    sourceText: "既存",
    translatedText: "기존",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0,
    autoFitText: false,
  };
}

function makeSidebarProps(): React.ComponentProps<typeof AppSidebar> {
  return {
    currentChapter: makeChapter(),
    selectedPageId: null,
    library: LIBRARY,
    jobActive: false,
    settingsBusy: false,
    settingsOpen: false,
    onOpenTranslationSource: vi.fn(),
    onOpenBatchImport: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenLibraryFolder: vi.fn(),
    onOpenShareExport: vi.fn(),
    onOpenShareImport: vi.fn(),
    onOpenChapter: vi.fn(),
    onRenameWork: vi.fn(),
    onRenameChapter: vi.fn(),
    onReorderChapter: vi.fn(),
    onSelectPage: vi.fn(),
    onRetranslatePage: vi.fn(),
    onRemovePage: vi.fn(),
    onReorderPage: vi.fn(),
  };
}

const FONTS_CONTEXT: FontsContextValue = {
  baseOptions: [],
  busy: false,
  catalog: DEFAULT_BLOCK_FONT_CATALOG,
  options: [],
  registerFont: async () => undefined,
  removeFont: async () => undefined,
  savePreferences: async () => undefined,
};

const LIBRARY: LibraryIndex = {
  workOrder: ["work-1"],
  works: [
    {
      id: "work-1",
      title: "테스트 작품",
      chapterOrder: ["chapter-1"],
      chapters: [
        {
          id: "chapter-1",
          workId: "work-1",
          title: "1화",
          status: "completed",
          pageCount: 3,
          createdAt: TS,
          updatedAt: TS,
        },
      ],
      createdAt: TS,
      updatedAt: TS,
    },
  ],
};
