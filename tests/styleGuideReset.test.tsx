// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type {
  ChapterStoryMemory,
  ResetWorkContextResult,
  WorkStyleGuide,
} from "../src/shared/workContextTypes";
import type { WorkContextUsage } from "../src/shared/workContextUsageTypes";

const gatewayMocks = vi.hoisted(() => ({
  analyzeWorkContext: vi.fn(),
  getChapterStoryMemory: vi.fn(),
  getWorkContextUsage: vi.fn(),
  getWorkStyleGuide: vi.fn(),
  resetWorkContext: vi.fn(),
  saveChapterStoryMemory: vi.fn(),
  saveWorkStyleGuide: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../src/renderer/src/api/mangaGateway", () => ({
  mangaGateway: gatewayMocks,
}));

vi.mock("../src/renderer/src/lib/toastStore", () => ({
  toast: toastMocks,
}));

import { StyleGuideModal } from "../src/renderer/src/components/StyleGuideModal";
import { workContextIpcContracts } from "../src/shared/ipcContracts";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";
const TS = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  gatewayMocks.getWorkStyleGuide.mockResolvedValue(makeGuide());
  gatewayMocks.getChapterStoryMemory.mockResolvedValue(makeMemory());
  gatewayMocks.getWorkContextUsage.mockResolvedValue(makeUsage(7));
  gatewayMocks.resetWorkContext.mockResolvedValue(makeResetResult());
  gatewayMocks.saveWorkStyleGuide.mockImplementation(async (guide) => guide);
  gatewayMocks.saveChapterStoryMemory.mockImplementation(
    async (memory) => memory,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StyleGuideModal complete reset", () => {
  it("does not call reset when the destructive confirmation is cancelled", async () => {
    renderModal();
    await screen.findByDisplayValue("魔王");

    fireEvent.click(resetButton());
    const confirmation = await screen.findByRole("dialog", {
      name: /용어·기억 전체 초기화/,
    });

    expect(
      within(confirmation).getByText(/모든 화의 스토리 메모리/),
    ).toBeTruthy();
    fireEvent.click(within(confirmation).getByRole("button", { name: "취소" }));
    expect(gatewayMocks.resetWorkContext).not.toHaveBeenCalled();
  });

  it("calls the reset contract after confirmation and applies its empty result", async () => {
    renderModal();
    await screen.findByDisplayValue("魔王");

    fireEvent.click(resetButton());
    fireEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: /용어·기억 전체 초기화/,
        }),
      ).getByRole("button", { name: "확인" }),
    );

    await waitFor(() => {
      expect(gatewayMocks.resetWorkContext).toHaveBeenCalledWith({
        chapterId: CHAPTER_ID,
      });
    });
    await waitFor(() => {
      expect(screen.queryByDisplayValue("魔王")).toBeNull();
    });
    expect(gatewayMocks.getWorkContextUsage).toHaveBeenCalledTimes(2);
    expect(toastMocks.success).toHaveBeenCalledWith(
      "용어/기억을 초기화하고 2화의 스토리 메모리를 비웠습니다.",
    );
  });

  it("keeps the reset action disabled while another app job is active", async () => {
    renderModal({ jobActive: true });
    await screen.findByDisplayValue("魔王");

    expect(resetButton().disabled).toBe(true);
    fireEvent.click(resetButton());

    expect(screen.queryByRole("button", { name: "확인" })).toBeNull();
    expect(gatewayMocks.resetWorkContext).not.toHaveBeenCalled();
  });

  it("ignores an older usage response that finishes after reset refresh", async () => {
    const initialUsage = createDeferred<WorkContextUsage>();
    const refreshedUsage = createDeferred<WorkContextUsage>();
    gatewayMocks.getWorkContextUsage
      .mockReturnValueOnce(initialUsage.promise)
      .mockReturnValueOnce(refreshedUsage.promise);
    gatewayMocks.resetWorkContext.mockResolvedValue({
      ...makeResetResult(),
      // Keep one entry visible so the usage metric remains observable.
      styleGuide: makeGuide(),
    });
    renderModal();
    const sourceInput = await screen.findByDisplayValue("魔王");

    fireEvent.click(resetButton());
    fireEvent.click(
      within(
        await screen.findByRole("dialog", {
          name: /용어·기억 전체 초기화/,
        }),
      ).getByRole("button", { name: "확인" }),
    );
    await waitFor(() => {
      expect(gatewayMocks.getWorkContextUsage).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      refreshedUsage.resolve(makeUsage(1));
      await refreshedUsage.promise;
    });
    expect(usageRow(sourceInput).textContent).toContain("1");

    await act(async () => {
      initialUsage.resolve(makeUsage(9));
      await initialUsage.promise;
    });
    expect(usageRow(sourceInput).textContent).toContain("1");
    expect(within(usageRow(sourceInput)).queryByText("9")).toBeNull();
  });
});

describe("reset work-context IPC contract", () => {
  it("keeps the reset channel, strict request, and result schema explicit", () => {
    const contract = workContextIpcContracts.resetWorkContext;

    expect(contract.apiKey).toBe("resetWorkContext");
    expect(contract.channel).toBe("context:reset-work-context");
    expect(contract.args.parse([{ chapterId: CHAPTER_ID }])).toEqual([
      { chapterId: CHAPTER_ID },
    ]);
    expect(
      contract.args.safeParse([
        { chapterId: CHAPTER_ID, unexpected: "not-allowed" },
      ]).success,
    ).toBe(false);
    expect(contract.result.parse(makeResetResult())).toEqual(makeResetResult());
    expect(
      contract.result.safeParse({
        ...makeResetResult(),
        resetChapterCount: -1,
      }).success,
    ).toBe(false);
  });
});

function renderModal({
  jobActive = false,
}: { jobActive?: boolean } = {}): void {
  render(
    <StyleGuideModal
      chapter={makeChapter()}
      jobActive={jobActive}
      settings={null}
      onClose={vi.fn()}
    />,
  );
}

function resetButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "용어·기억 전체 초기화",
  }) as HTMLButtonElement;
}

function usageRow(sourceInput: HTMLElement): HTMLElement {
  const row = sourceInput.closest(".style-guide-row");
  if (!row) throw new Error("Glossary row was not rendered.");
  return row as HTMLElement;
}

function makeChapter(): ChapterSnapshot {
  return {
    id: CHAPTER_ID,
    workId: WORK_ID,
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: [PAGE_ID],
    pages: [
      {
        id: PAGE_ID,
        name: "001.png",
        imagePath: "C:/library/001.png",
        dataUrl: "",
        width: 100,
        height: 150,
        blocks: [],
        analysisStatus: "completed",
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeGuide(): WorkStyleGuide {
  return {
    schemaVersion: 1,
    workId: WORK_ID,
    glossary: [
      {
        id: "term-1",
        source: "魔王",
        target: "마왕",
        category: "term",
        enabled: true,
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    characters: [],
    rules: {
      honorifics: "preserve",
      sfxMode: "note",
      defaultTone: "literal",
    },
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeMemory(): ChapterStoryMemory {
  return {
    schemaVersion: 1,
    workId: WORK_ID,
    chapterId: CHAPTER_ID,
    pages: [
      {
        pageId: PAGE_ID,
        pageName: "001.png",
        pageIndex: 0,
        sourceDigest: "魔王",
        translatedDigest: "마왕",
        summary: "마왕이 등장한다.",
        updatedAt: TS,
      },
    ],
    updatedAt: TS,
    aiAnalyzedAt: TS,
  };
}

function makeResetResult(): ResetWorkContextResult {
  return {
    styleGuide: {
      ...makeGuide(),
      glossary: [],
      characters: [],
    },
    storyMemory: {
      ...makeMemory(),
      pages: [],
      aiAnalyzedAt: undefined,
    },
    resetChapterCount: 2,
  };
}

function makeUsage(mentionCount: number): WorkContextUsage {
  return {
    workId: WORK_ID,
    glossary: [{ id: "term-1", pageCount: 1, mentionCount }],
    characters: [],
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
