// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
  PageAnalysisStatus,
} from "../src/shared/libraryTypes";
import type { UiSettings } from "../src/shared/settingsTypes";
import type { TranslationOptionsInitialScope } from "../src/renderer/src/lib/translationSelection";
import { createPageRevision } from "../src/shared/pageRevision";

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    getPageImageDataUrl: vi.fn(() => Promise.resolve("mgt-image://token")),
    openChapter: vi.fn(() => Promise.resolve(makeCurrentChapter())),
  });
});

import { TranslationOptionsModal } from "../src/renderer/src/components/TranslationOptionsModal";
import {
  OptionRow,
  ToggleOptionRow,
} from "../src/renderer/src/components/TranslationOptionControls";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const TS = "2026-01-01T00:00:00.000Z";

function makePage(id: string, status: PageAnalysisStatus): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `C:/${id}.png`,
    dataUrl: "",
    width: 100,
    height: 150,
    blocks: [],
    analysisStatus: status,
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeCurrentChapter(): ChapterSnapshot {
  return {
    id: CHAPTER_ID,
    workId: WORK_ID,
    title: "1화",
    sourceKind: "images",
    status: "partial",
    pageOrder: ["p1", "p2"],
    pages: [makePage("p1", "completed"), makePage("p2", "idle")],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeCheckpointChapter(): ChapterSnapshot {
  const pages = Array.from({ length: 12 }, (_value, index) => {
    const page = makePage(`p${index + 1}`, "idle");
    if (index >= 5) return page;
    return {
      ...page,
      translationCheckpoint: {
        schemaVersion: 1 as const,
        pipelineContractVersion: "whole-page-prepared-v1" as const,
        artifactPath: `.translation-checkpoint-${index}/checkpoint.json`,
        sha256: "a".repeat(64),
        byteSize: 100,
        inputRevision: createPageRevision(page),
        sourceLanguage: "ja",
        targetLanguage: "ko",
        blockMode: "auto" as const,
        savedAt: TS,
      },
    };
  });
  return {
    ...makeCurrentChapter(),
    status: "partial",
    pageOrder: pages.map((page) => page.id),
    pages,
  };
}

function makeLibrary(
  currentChapter: ChapterSnapshot = makeCurrentChapter(),
): LibraryIndex {
  return {
    workOrder: [WORK_ID],
    works: [
      {
        id: WORK_ID,
        title: "테스트 작품",
        chapterOrder: [CHAPTER_ID, "c2"],
        createdAt: TS,
        updatedAt: TS,
        chapters: [
          {
            id: CHAPTER_ID,
            workId: WORK_ID,
            title: currentChapter.title,
            status: currentChapter.status,
            createdAt: TS,
            updatedAt: TS,
            pageCount: currentChapter.pages.length,
          },
          {
            id: "c2",
            workId: WORK_ID,
            title: "2화",
            status: "idle",
            createdAt: TS,
            updatedAt: TS,
            pageCount: 3,
          },
        ],
      },
    ],
  };
}

async function renderModal(
  uiSettings?: UiSettings,
  initialScope?: TranslationOptionsInitialScope,
  chapter: ChapterSnapshot = makeCurrentChapter(),
  currentPageId?: string,
) {
  const onStart = vi.fn();
  const onClose = vi.fn();
  const onPersistDefaults = vi.fn();
  render(
    <TranslationOptionsModal
      chapter={chapter}
      currentPageId={currentPageId}
      initialScope={initialScope}
      library={makeLibrary(chapter)}
      uiSettings={uiSettings}
      onStart={onStart}
      onPersistDefaults={onPersistDefaults}
      onClose={onClose}
    />,
  );
  // flush the lazy thumbnail image effects
  await act(async () => {
    await Promise.resolve();
  });
  return { onStart, onClose, onPersistDefaults };
}

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("TranslationOptionsModal", () => {
  it("renders a flat switch even when no tooltip copy is provided", () => {
    const onChange = vi.fn();
    render(
      <ToggleOptionRow
        label="설명 없는 옵션"
        pressed={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "설명 없는 옵션" }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps a disabled segmented option visibly and semantically disabled", () => {
    render(
      <OptionRow
        label="비활성 옵션"
        options={[{ id: "only", label: "선택지" }]}
        value="only"
        onChange={vi.fn()}
        disabled
      />,
    );

    const option = screen.getByRole("radio", { name: "선택지" });
    expect(option).toHaveProperty("disabled", true);
    expect(option.closest(".translate-options-row")?.className).toContain(
      "disabled",
    );
  });

  it("defaults to the current chapter's pending pages", async () => {
    const { onStart, onClose, onPersistDefaults } = await renderModal();

    expect(screen.getByText("1화")).toBeTruthy();
    expect(screen.getByText("2화")).toBeTruthy();
    // work title + expanded current chapter's page names are visible
    expect(screen.getByText("테스트 작품")).toBeTruthy();
    expect(screen.getByText("p1.png")).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "누적 컨텍스트 (권장)" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: "자연스러운 줄 나눔" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("switch", { name: "폰트 자동 맞춤" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen.getByText(
        /원문 분위기에 어울리는 한글 폰트를 블록마다 자동 적용합니다/,
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("radio", { name: "번역만" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const bubbleLayout = screen.getByRole("switch", { name: "말풍선 맞춤" });
    expect(bubbleLayout).toHaveProperty("disabled", true);
    expect(bubbleLayout.getAttribute("aria-checked")).toBe("false");
    expect(getDescribedTooltipText(bubbleLayout)).toBe(
      "원문 지우기를 선택해야 사용할 수 있습니다.",
    );
    expect(screen.queryByText("자동 분석 범위")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));

    expect(onStart).toHaveBeenCalledWith({
      selection: [
        {
          chapterId: CHAPTER_ID,
          mode: "page-set",
          pageIds: ["p2"],
          restartPageIds: ["p2"],
        },
      ],
      workflowMode: "cumulative",
      cumulativeContextDetail: "detailed",
      blockMode: "auto",
      autoFontMatching: false,
      fontSizeAutoFit: true,
      naturalTextLayout: true,
      eraseOriginalWorkflow: false,
      bubbleLayoutWorkflow: false,
    });
    expect(onPersistDefaults).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("marks and scrolls to the working page once while keeping its filename primary", async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      await renderModal(undefined, undefined, makeCheckpointChapter(), "p10");

      const currentCheckbox = screen.getByRole("checkbox", {
        name: /p10\.png/,
      });
      const currentCard = currentCheckbox.closest("label");
      expect(currentCard?.getAttribute("aria-current")).toBe("page");
      expect(
        screen
          .getByRole("checkbox", { name: /p9\.png/ })
          .closest("label")
          ?.hasAttribute("aria-current"),
      ).toBe(false);
      const caption = currentCard?.querySelector(".translate-page-thumb-cap");
      expect(caption?.children[0]?.className).toBe("translate-page-thumb-name");
      expect(caption?.children[0]?.textContent).toBe("p10.png");
      expect(caption?.children[1]?.textContent).toBe("#10");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "center",
        inline: "nearest",
      });

      fireEvent.click(currentCheckbox);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScrollIntoView,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("safely skips current-page scrolling when the page is unavailable", async () => {
    await renderModal(undefined, undefined, makeCheckpointChapter(), "missing");

    expect(document.querySelector('[aria-current="page"]')).toBeNull();
  });

  it("does not expose the removed precision two-pass workflow", async () => {
    await renderModal();

    expect(screen.queryByRole("radio", { name: /정밀 2차/ })).toBeNull();
    expect(screen.queryByText("자동 분석 범위")).toBeNull();
  });

  it("uses a saved quick single-pass workflow as the initial mode", async () => {
    await renderModal({ translationWorkflowDefault: "standard" });

    expect(
      screen
        .getByRole("radio", { name: "빠른 1회" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByText("자동 분석 범위")).toBeNull();
  });

  it("puts compact guidance in tooltips instead of visible helper rows", async () => {
    await renderModal();

    expect(screen.getByRole("heading", { name: "번역 품질" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "블록 · 줄 나눔" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "완료 처리" })).toBeTruthy();
    const quickMode = screen.getByRole("radio", { name: "빠른 1회" });
    const cumulativeMode = screen.getByRole("radio", {
      name: "누적 컨텍스트 (권장)",
    });
    const translateOnly = screen.getByRole("radio", { name: "번역만" });
    expect(quickMode.closest(".control-tooltip")?.className).toContain(
      "control-tooltip-bottom",
    );
    expect(translateOnly.closest(".control-tooltip")?.className).toContain(
      "control-tooltip-top",
    );
    expect(getDescribedTooltipText(quickMode)).toBe(
      "각 페이지를 한 번만 번역하고 간단한 최근 문맥만 참고합니다. 가장 빠릅니다.",
    );
    expect(getDescribedTooltipText(cumulativeMode)).toBe(
      "번역하면서 페이지의 장면 요약·용어·캐릭터 정보를 쌓아 다음 페이지부터 참고합니다.",
    );
    expect(screen.queryByText("상세 기록 (기존)")).toBeTruthy();
    expect(
      document.querySelector(".translate-options-selected-hint"),
    ).toBeNull();
    expect(screen.getAllByRole("tooltip").length).toBeGreaterThan(3);
    expect(
      screen.getByText("블록 크기에 맞춰 번역문의 줄바꿈을 정돈합니다."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /원문 분위기에 어울리는 한글 폰트를 블록마다 자동 적용합니다/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "텍스트 블록 크기에 맞춰 번역문 자체에 줄바꿈을 넣습니다. 매우 좁고 긴 새 블록은 한 열에 들어갈 때만 세로쓰기로 설정하며, 블록의 줄바꿈 방식 설정은 바꾸지 않습니다.",
      ),
    ).toBeNull();

    fireEvent.click(quickMode);
    expect(getDescribedTooltipText(quickMode)).toContain("가장 빠릅니다.");
    expect(getDescribedTooltipText(cumulativeMode)).toContain(
      "장면 요약·용어·캐릭터 정보",
    );

    fireEvent.click(screen.getByRole("radio", { name: "원문 지우기" }));
    expect(
      screen
        .getByRole("switch", { name: "말풍선 맞춤" })
        .closest(".control-tooltip")?.className,
    ).toContain("control-tooltip-top");
  });

  it("offers three cumulative context scopes and forwards the selected policy", async () => {
    const { onStart, onPersistDefaults } = await renderModal();

    expect(
      screen.getByRole("radiogroup", { name: "컨텍스트 기록 범위" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "균형 기록" }));
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "다음 번역의 기본값으로 저장",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ cumulativeContextDetail: "balanced" }),
    );
    expect(onPersistDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ cumulativeContextDetailDefault: "balanced" }),
    );
  });

  it("preserves an explicitly saved natural line layout off setting", async () => {
    const { onStart, onPersistDefaults } = await renderModal({
      naturalTextLayoutDefault: false,
    });

    expect(
      screen
        .getByRole("switch", { name: "자연스러운 줄 나눔" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "다음 번역의 기본값으로 저장",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ naturalTextLayout: false }),
    );
    expect(onPersistDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ naturalTextLayoutDefault: false }),
    );
  });

  it("can enable automatic font matching and persists the choice", async () => {
    const { onStart, onPersistDefaults } = await renderModal();
    const toggle = screen.getByRole("switch", { name: "폰트 자동 맞춤" });

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "다음 번역의 기본값으로 저장",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ autoFontMatching: true }),
    );
    expect(onPersistDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ autoFontMatchingDefault: true }),
    );
  });

  it("can disable source-aware font size matching and persists the choice", async () => {
    const { onStart, onPersistDefaults } = await renderModal();
    const toggle = screen.getByRole("switch", {
      name: "글자 크기 자동 맞춤",
    });

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "다음 번역의 기본값으로 저장",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ fontSizeAutoFit: false }),
    );
    expect(onPersistDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ fontSizeAutoFitDefault: false }),
    );
  });

  it("persists and starts the combined bubble layout workflow when enabled", async () => {
    const { onStart, onPersistDefaults } = await renderModal();

    fireEvent.click(screen.getByRole("radio", { name: "원문 지우기" }));
    const bubbleOptions = screen.getByRole("switch", {
      name: "말풍선 맞춤",
    });
    expect(bubbleOptions.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "다음 번역의 기본값으로 저장",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        eraseOriginalWorkflow: true,
        bubbleLayoutWorkflow: true,
      }),
    );
    expect(onPersistDefaults).toHaveBeenCalledWith(
      expect.objectContaining({
        eraseOriginalWorkflowDefault: true,
        bubbleLayoutWorkflowDefault: true,
      }),
    );
  });

  it("can erase source text without running bubble fitting", async () => {
    const { onStart, onPersistDefaults } = await renderModal();

    fireEvent.click(screen.getByRole("radio", { name: "원문 지우기" }));
    const bubbleOptions = screen.getByRole("switch", {
      name: "말풍선 맞춤",
    });
    fireEvent.click(bubbleOptions);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "다음 번역의 기본값으로 저장",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        eraseOriginalWorkflow: true,
        bubbleLayoutWorkflow: false,
      }),
    );
    expect(onPersistDefaults).toHaveBeenCalledWith(
      expect.objectContaining({
        eraseOriginalWorkflowDefault: true,
        bubbleLayoutWorkflowDefault: false,
      }),
    );
  });

  it("preserves a saved nested bubble fitting off setting", async () => {
    await renderModal({
      eraseOriginalWorkflowDefault: true,
      bubbleLayoutWorkflowDefault: false,
    });

    expect(
      screen
        .getByRole("radio", { name: "원문 지우기" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    const bubbleOptions = screen.getByRole("switch", {
      name: "말풍선 맞춤",
    });
    expect(bubbleOptions.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps bubble fitting visible and restores its preference after translate-only mode", async () => {
    await renderModal();

    expect(
      screen.getByText("번역만 완료하고 원문은 그대로 둡니다."),
    ).toBeTruthy();
    const bubbleOptions = screen.getByRole("switch", {
      name: "말풍선 맞춤",
    });
    expect(bubbleOptions).toHaveProperty("disabled", true);
    expect(bubbleOptions.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("radio", { name: "원문 지우기" }));
    expect(bubbleOptions).toHaveProperty("disabled", false);
    expect(bubbleOptions.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "번역만" }));
    expect(bubbleOptions).toHaveProperty("disabled", true);
    expect(bubbleOptions.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("radio", { name: "원문 지우기" }));
    expect(bubbleOptions).toHaveProperty("disabled", false);
    expect(bubbleOptions.getAttribute("aria-checked")).toBe("true");
  });

  it("preserves the bubble preference as a default while disabling it for a translate-only run", async () => {
    const { onPersistDefaults, onStart } = await renderModal();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "다음 번역의 기본값으로 저장",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));

    expect(onPersistDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ bubbleLayoutWorkflowDefault: true }),
    );
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        eraseOriginalWorkflow: false,
        bubbleLayoutWorkflow: false,
      }),
    );
  });

  it("selects the whole work with 전체 선택", async () => {
    const { onStart } = await renderModal();

    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));
    const confirmDialog = screen.getAllByRole("dialog").at(-1);
    if (!confirmDialog) throw new Error("overwrite confirmation not found");
    fireEvent.click(
      within(confirmDialog).getByRole("button", {
        name: "선택 범위 다시 번역",
      }),
    );

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: [
          { chapterId: CHAPTER_ID, mode: "all" },
          { chapterId: "c2", mode: "all" },
        ],
      }),
    );
  });

  it("runs an external idle chapter without showing an overwrite warning", async () => {
    const { onStart } = await renderModal();

    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "2화" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: [{ chapterId: "c2", mode: "all" }],
      }),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("shows resumable pages as dashes with a concise summary and exact cycle", async () => {
    await renderModal(undefined, undefined, makeCheckpointChapter());

    expect(
      screen.getByText("1–5페이지 번역 결과 재사용 · 6페이지부터 새로 번역"),
    ).toBeTruthy();
    const resumeTooltips = screen.getAllByRole("tooltip", {
      name: "번역 결과까지 재사용 · 폰트 맞춤부터 계속",
    });
    expect(resumeTooltips).toHaveLength(5);
    const firstPage = screen.getByRole("checkbox", { name: /p1\.png/ });
    expect(firstPage.getAttribute("aria-checked")).toBe("mixed");
    expect((firstPage as HTMLInputElement).indeterminate).toBe(true);
    expect(
      screen.getByRole("button", { name: "선택 범위 이어서 번역" }),
    ).toBeTruthy();

    fireEvent.focus(firstPage);
    expect(resumeTooltips[0]?.classList.contains("is-open")).toBe(true);
    fireEvent.blur(firstPage);
    expect(resumeTooltips[0]?.classList.contains("is-open")).toBe(false);

    fireEvent.click(firstPage);
    expect(firstPage.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("4페이지 재사용 · 8페이지 새로 번역")).toBeTruthy();

    fireEvent.click(firstPage);
    expect(firstPage.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(firstPage);
    expect(firstPage.getAttribute("aria-checked")).toBe("mixed");
  });

  it("applies the clicked anchor state with Shift across the same chapter", async () => {
    await renderModal(undefined, undefined, makeCheckpointChapter());

    const firstPage = screen.getByRole("checkbox", { name: /p1\.png/ });
    fireEvent.click(firstPage);
    expect(firstPage.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("checkbox", { name: /p4\.png/ }), {
      shiftKey: true,
    });

    for (const pageNumber of [1, 2, 3, 4]) {
      expect(
        screen
          .getByRole("checkbox", { name: new RegExp(`p${pageNumber}\\.png`) })
          .getAttribute("aria-checked"),
      ).toBe("true");
    }
    expect(
      screen
        .getByRole("checkbox", { name: /p5\.png/ })
        .getAttribute("aria-checked"),
    ).toBe("mixed");
  });

  it("clears the Shift anchor after bulk selection actions", async () => {
    await renderModal(undefined, undefined, makeCheckpointChapter());

    fireEvent.click(screen.getByRole("checkbox", { name: /p1\.png/ }));
    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /p3\.png/ }), {
      shiftKey: true,
    });

    expect(
      screen
        .getByRole("checkbox", { name: /p1\.png/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("checkbox", { name: /p2\.png/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen
        .getByRole("checkbox", { name: /p3\.png/ })
        .getAttribute("aria-checked"),
    ).toBe("mixed");
  });

  it("clears the Shift anchor when translation compatibility changes", async () => {
    await renderModal(undefined, undefined, makeCheckpointChapter());

    fireEvent.click(screen.getByRole("checkbox", { name: /p1\.png/ }));
    fireEvent.click(screen.getByRole("radio", { name: "기존 블록 유지" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /p3\.png/ }), {
      shiftKey: true,
    });

    expect(
      screen
        .getByRole("checkbox", { name: /p2\.png/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: /p3\.png/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("labels postprocess-only resume without implying font matching is skipped", async () => {
    const page: MangaPage = {
      ...makePage("p1", "completed"),
      translationCompletion: {
        workflow: "bubble-layout",
        status: "pending",
      },
    };
    const chapter: ChapterSnapshot = {
      ...makeCurrentChapter(),
      status: "partial",
      pageOrder: [page.id],
      pages: [page],
    };

    await renderModal(
      {
        eraseOriginalWorkflowDefault: true,
        bubbleLayoutWorkflowDefault: true,
      },
      undefined,
      chapter,
    );

    expect(
      screen.getByRole("tooltip", {
        name: "번역·폰트 설정 재사용 · 원문 지우기부터 계속",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("1페이지 번역·폰트 설정 재사용 · 원문 지우기부터 계속"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "선택 범위 이어서 번역" }),
    ).toBeTruthy();
  });

  it("disables execution when a fully completed chapter has no target", async () => {
    const pages = [makePage("p1", "completed"), makePage("p2", "completed")];
    const chapter: ChapterSnapshot = {
      ...makeCurrentChapter(),
      status: "completed",
      pageOrder: pages.map((page) => page.id),
      pages,
    };

    await renderModal(undefined, undefined, chapter);

    expect(
      screen.getByRole("button", { name: "선택 범위 번역" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByText("선택된 페이지가 없습니다.")).toBeTruthy();
  });

  it("starts with the whole work selected for a batch import", async () => {
    const { onStart } = await renderModal(undefined, "work-all");

    expect(screen.getByRole("button", { name: "전체 해제" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));
    const confirmDialog = screen.getAllByRole("dialog").at(-1);
    if (!confirmDialog) throw new Error("overwrite confirmation not found");
    fireEvent.click(
      within(confirmDialog).getByRole("button", {
        name: "선택 범위 다시 번역",
      }),
    );

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: [
          { chapterId: CHAPTER_ID, mode: "all" },
          { chapterId: "c2", mode: "all" },
        ],
      }),
    );
  });

  it("disables selection translation when nothing is selected", async () => {
    const { onStart } = await renderModal();

    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));

    const startButton = screen.getByRole("button", {
      name: "선택 범위 번역",
    });
    expect(startButton).toHaveProperty("disabled", true);

    fireEvent.click(startButton);
    expect(onStart).not.toHaveBeenCalled();
  });
});

function getDescribedTooltipText(control: HTMLElement): string {
  const describedBy = control.getAttribute("aria-describedby");
  if (!describedBy) throw new Error("control has no tooltip description");
  return describedBy
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}
