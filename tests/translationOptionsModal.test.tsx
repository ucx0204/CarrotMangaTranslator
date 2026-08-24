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

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    getPageImageDataUrl: vi.fn(() => Promise.resolve("mgt-image://token")),
    openChapter: vi.fn(() => Promise.resolve(makeCurrentChapter())),
  });
});

import { TranslationOptionsModal } from "../src/renderer/src/components/TranslationOptionsModal";

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

function makeLibrary(): LibraryIndex {
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
            title: "1화",
            status: "partial",
            createdAt: TS,
            updatedAt: TS,
            pageCount: 2,
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
) {
  const onStart = vi.fn();
  const onClose = vi.fn();
  const onPersistDefaults = vi.fn();
  render(
    <TranslationOptionsModal
      chapter={makeCurrentChapter()}
      initialScope={initialScope}
      library={makeLibrary()}
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
    expect(screen.queryByRole("switch", { name: "말풍선 맞춤" })).toBeNull();
    expect(screen.queryByText("자동 분석 범위")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "선택 범위 번역" }));

    expect(onStart).toHaveBeenCalledWith({
      selection: [{ chapterId: CHAPTER_ID, mode: "pending" }],
      workflowMode: "cumulative",
      blockMode: "auto",
      autoFontMatching: false,
      naturalTextLayout: true,
      eraseOriginalWorkflow: false,
      bubbleLayoutWorkflow: true,
    });
    expect(onPersistDefaults).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
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

  it("groups compact options and only shows selected-option guidance", async () => {
    await renderModal();

    expect(screen.getByRole("heading", { name: "번역 품질" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "블록 · 줄 나눔" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "완료 처리" })).toBeTruthy();
    expect(
      screen.getByText(
        "번역하면서 페이지의 장면 요약·용어·캐릭터 정보를 쌓아 다음 페이지부터 참고합니다.",
      ),
    ).toBeTruthy();
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

    fireEvent.click(screen.getByRole("radio", { name: "빠른 1회" }));
    expect(
      screen.getByText(
        "각 페이지를 한 번만 번역하고 간단한 최근 문맥만 참고합니다. 가장 빠릅니다.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "번역하면서 페이지의 장면 요약·용어·캐릭터 정보를 쌓아 다음 페이지부터 참고합니다.",
      ),
    ).toBeNull();
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

  it("selects the whole work with 전체 선택", async () => {
    const { onStart } = await renderModal();

    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    fireEvent.click(
      screen.getByRole("button", { name: "선택 범위 다시 번역" }),
    );
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

  it("starts with the whole work selected for a batch import", async () => {
    const { onStart } = await renderModal(undefined, "work-all");

    expect(screen.getByRole("button", { name: "전체 해제" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "선택 범위 다시 번역" }),
    );
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
