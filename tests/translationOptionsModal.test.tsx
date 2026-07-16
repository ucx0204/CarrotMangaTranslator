// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
  PageAnalysisStatus,
} from "../src/shared/libraryTypes";
import type { UiSettings } from "../src/shared/settingsTypes";

vi.mock("../src/renderer/src/api/mangaGateway", () => ({
  mangaGateway: {
    getPageImageDataUrl: vi.fn(() => Promise.resolve("mgt-image://token")),
    openChapter: vi.fn(() => Promise.resolve(makeCurrentChapter())),
  },
}));

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

async function renderModal(uiSettings?: UiSettings) {
  const onStart = vi.fn();
  const onClose = vi.fn();
  const onPersistDefaults = vi.fn();
  render(
    <TranslationOptionsModal
      chapter={makeCurrentChapter()}
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
        .getByRole("button", { name: "누적 컨텍스트 (권장)" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByText("자동 분석 범위")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "번역 시작" }));

    expect(onStart).toHaveBeenCalledWith({
      selection: [{ chapterId: CHAPTER_ID, mode: "pending" }],
      workflowMode: "cumulative",
      analysisScope: "missing",
      blockMode: "auto",
    });
    expect(onPersistDefaults).toHaveBeenCalledWith({
      translationWorkflowDefault: "cumulative",
      analysisScopeDefault: "missing",
      blockModeDefault: "auto",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows analysis scope only for the precision two-pass workflow", async () => {
    const { onStart } = await renderModal();

    fireEvent.click(screen.getByRole("button", { name: "정밀 2차" }));

    expect(screen.getByText("자동 분석 범위")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "현재 화만" }));
    fireEvent.click(screen.getByRole("button", { name: "번역 시작" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowMode: "two-pass",
        analysisScope: "chapter",
      }),
    );
  });

  it("uses a saved quick single-pass workflow as the initial mode", async () => {
    await renderModal({ translationWorkflowDefault: "standard" });

    expect(
      screen
        .getByRole("button", { name: "빠른 1회" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByText("자동 분석 범위")).toBeNull();
  });

  it("selects the whole work with 전체 선택", async () => {
    const { onStart } = await renderModal();

    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "번역 시작" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: [
          { chapterId: CHAPTER_ID, mode: "all" },
          { chapterId: "c2", mode: "all" },
        ],
      }),
    );
  });

  it("disables 번역 시작 when nothing is selected", async () => {
    const { onStart } = await renderModal();

    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));

    const startButton = screen.getByRole("button", { name: "번역 시작" });
    expect(startButton).toHaveProperty("disabled", true);

    fireEvent.click(startButton);
    expect(onStart).not.toHaveBeenCalled();
  });
});
