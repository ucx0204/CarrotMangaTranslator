/** @vitest-environment jsdom */
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { PageWorkflowTiming } from "../src/shared/pageWorkflowTiming";
import { PAGE_PROCESSING_TIMING_VERSION } from "../src/shared/pageProcessingTiming";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { PageTimingDialog } from "../src/renderer/src/components/pageList/PageTimingDialog";
import { PageWorkflowTimingView } from "../src/renderer/src/components/pageList/PageWorkflowTimingView";
import { formatDateTime } from "../src/renderer/src/components/pageList/pageTimingFormat";
import { WORKFLOW_TIMING_POLL_MS } from "../src/renderer/src/components/pageList/usePageWorkflowTimings";
import {
  buildWorkflowAttemptEntries,
  buildTimingEntries,
  attemptStageCell,
  pageStageCell,
} from "../src/renderer/src/components/pageList/pageWorkflowTimingModel";

const CHAPTER_A = "00000000-0000-4000-8000-0000000000a1";
const CHAPTER_B = "00000000-0000-4000-8000-0000000000b1";
const RUN = "00000000-0000-4000-8000-000000000101";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "mangaApi");
});

describe("page timing dialog views", () => {
  it("keeps an unreadable legacy date visible without breaking the history", () => {
    expect(formatDateTime("unknown legacy date", "ko")).toBe(
      "unknown legacy date",
    );
  });
  it("shows existing and new records in one history without tabs", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      getPageWorkflowTimings: async () => [
        attempt({ attemptId: id(1), chapterId: CHAPTER_A, elapsedMs: 9_000 }),
      ],
    });
    render(
      <PageTimingDialog
        chapterId={CHAPTER_A}
        pages={[legacyPage()]}
        selectedPageId={null}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByRole("tab")).toBeNull();
    expect(await screen.findByText("실행 전체 시간")).toBeTruthy();
    const list = screen.getByRole("navigation", { name: "작업 실행 기록" });
    const entries = within(list).getAllByRole("button");
    expect(entries).toHaveLength(2);
    fireEvent.click(entries[1]);
    expect(screen.getByText("기록된 단계 합계")).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "이 화의 페이지" }).textContent,
    ).toContain("legacy.png");
    expect(cells(screen.getByRole("row", { name: /^번역 / }))).toEqual([
      "1.20초",
      "1.20초",
    ]);
    expect(screen.queryByText("실행 후 정리")).toBeNull();
    expect(screen.queryByText("종료 전")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("shows only the translation view when no chapter is open", () => {
    render(
      <PageTimingDialog
        chapterId={null}
        pages={[legacyPage()]}
        selectedPageId={null}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByRole("tab")).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "이 화의 페이지" }),
    ).toBeTruthy();
  });
});

describe("page-task timing view", () => {
  it("groups existing snapshots by session without inventing wall time or changing source data", () => {
    const first = legacyPage();
    const second = { ...legacyPage(), id: "second", name: "second.png" };
    const noTiming = {
      ...legacyPage(),
      id: "empty",
      processingTiming: undefined,
    };
    const before = structuredClone([first, second, noTiming]);
    const [entry] = buildTimingEntries(
      [],
      [first, second, noTiming],
      CHAPTER_A,
    );
    expect(entry.chapterPages.map((page) => page.pageId)).toEqual([
      "legacy",
      "second",
    ]);
    expect(entry.attempt.measuredMs).toBe(2400);
    expect(entry.attempt.elapsedMs).toBeUndefined();
    expect(entry.attempt.startedAt).toBeUndefined();
    expect(entry.attempt.finishedAt).toBeUndefined();
    expect(entry.attempt.cleanupMs).toBeUndefined();
    expect([first, second, noTiming]).toEqual(before);
    expect(attemptStageCell(entry.attempt, "preparing")).toEqual({
      kind: "missing",
    });
  });

  it.each(["running", "interrupted"] as const)(
    "preserves %s snapshots and measured zero",
    (state) => {
      const page = legacyPage();
      if (page.processingTiming?.version !== 2)
        throw new Error("Expected v2 fixture");
      page.processingTiming = {
        ...page.processingTiming,
        state,
        stages: { ocr: 0 },
      };
      const [entry] = buildTimingEntries([], [page], null);
      expect(entry.attempt.status).toBe(state);
      expect(entry.attempt.chapters).toEqual([]);
      expect(pageStageCell(entry.chapterPages[0], "ocr")).toEqual({
        kind: "measured",
        milliseconds: 0,
      });
      expect(pageStageCell(entry.chapterPages[0], "translate")).toEqual({
        kind: "missing",
      });
    },
  );

  it("retains ungrouped v1 snapshots and the established merged stage meanings", () => {
    const page = legacyPage();
    page.processingTiming = {
      version: 1,
      measuredAt: "2026-01-01T00:00:00Z",
      stages: {
        translation: 1000,
        postprocessing: 200,
        typography: 300,
        bubbleLayout: 400,
      },
    };
    const entries = buildTimingEntries(
      [],
      [page, { ...page, id: "other" }],
      CHAPTER_A,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].attempt.stages).toEqual({
      translate: 1200,
      typography: 700,
    });
    expect(entries[0].attempt.measuredMs).toBe(1900);
  });

  it("keeps existing records accessible when loading new history fails", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      getPageWorkflowTimings: async () => {
        throw new Error("offline");
      },
    });
    render(
      <PageTimingDialog
        chapterId={CHAPTER_A}
        pages={[legacyPage()]}
        selectedPageId={null}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByText("갱신하지 못했습니다.")).toBeTruthy();
    expect(screen.getByText("기록된 단계 합계")).toBeTruthy();
    expect(cells(screen.getByRole("row", { name: /^번역 / }))).toEqual([
      "1.20초",
      "1.20초",
    ]);
  });

  it("separates measured zero, skipped and unmeasured stages", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      getPageWorkflowTimings: async () => [
        attempt({
          attemptId: id(1),
          chapterId: CHAPTER_A,
          stages: { detect: 0, ocr: 1_500 },
          pages: [
            {
              chapterId: CHAPTER_A,
              pageId: "p1",
              pageName: "001.png",
              stages: { detect: 0 },
              skippedStages: ["translate"],
            },
          ],
        }),
      ],
    });
    render(
      <PageWorkflowTimingView chapterId={CHAPTER_A} selectedPageId="p1" />,
    );

    const detect = await screen.findByRole("row", { name: /블록 검출/ });
    expect(cells(detect)).toEqual(["0.00초", "0.00초"]);
    const ocr = screen.getByRole("row", { name: /원문 읽기/ });
    expect(cells(ocr)).toEqual(["1.50초", "—측정 안 됨"]);
    const translate = screen.getByRole("row", { name: /^번역 / });
    expect(cells(translate)).toEqual(["—측정 안 됨", "건너뜀"]);
  });

  it("does not report a stage as skipped when it was measured", () => {
    expect(
      pageStageCell(
        {
          chapterId: CHAPTER_A,
          pageId: "p1",
          pageName: "001.png",
          stages: { erase: 20 },
          skippedStages: ["erase"],
        },
        "erase",
      ),
    ).toEqual({ kind: "measured", milliseconds: 20 });
  });

  it("lists resume attempts separately and lets each be opened", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      getPageWorkflowTimings: async () => [
        attempt({
          attemptId: id(1),
          chapterId: CHAPTER_A,
          status: "interrupted",
          startedAt: "2026-10-12T01:00:00.000Z",
          elapsedMs: 61_000,
        }),
        attempt({
          attemptId: id(2),
          chapterId: CHAPTER_A,
          status: "completed",
          startedAt: "2026-10-12T02:00:00.000Z",
          elapsedMs: 4_000,
        }),
      ],
    });
    render(
      <PageWorkflowTimingView chapterId={CHAPTER_A} selectedPageId={null} />,
    );

    const list = await screen.findByRole("navigation", {
      name: "작업 실행 기록",
    });
    const items = within(list).getAllByRole("button");
    expect(items).toHaveLength(2);
    // History is pruned, so only "resumed" is claimed, never an ordinal.
    expect(items[0].textContent).toContain("이어서 실행");
    expect(items[0].textContent).not.toMatch(/번째/);
    expect(items[1].textContent).not.toContain("이어서 실행");
    expect(items[0].getAttribute("aria-current")).toBe("true");
    expect(totalText()).toBe("4.00초");

    fireEvent.click(items[1]);
    expect(totalText()).toBe("1분 1.00초");
    expect(within(items[1]).getByText("중단됨").getAttribute("title")).toMatch(
      /앱이 종료되었습니다/,
    );
    expect(within(items[1]).getByText("중단됨")).toBeTruthy();
  });

  it("uses the recorded wall time instead of summing stages or pages", () => {
    const [entry] = buildWorkflowAttemptEntries(
      [
        attempt({
          attemptId: id(1),
          chapterId: CHAPTER_A,
          elapsedMs: 10_000,
          stages: { ocr: 1_000, translate: 2_000 },
        }),
      ],
      CHAPTER_A,
    );
    expect(entry.attempt.elapsedMs).toBe(10_000);
  });

  it("ignores a late answer for the previous chapter", async () => {
    const pending = new Map<string, (value: PageWorkflowTiming[]) => void>();
    window.mangaApi = createTestMangaGatewayStub({
      getPageWorkflowTimings: (chapterId: string) =>
        new Promise((resolve) => pending.set(chapterId, resolve)),
    });
    const view = render(
      <PageWorkflowTimingView chapterId={CHAPTER_A} selectedPageId={null} />,
    );
    view.rerender(
      <PageWorkflowTimingView chapterId={CHAPTER_B} selectedPageId={null} />,
    );
    await act(async () => {
      pending.get(CHAPTER_B)?.([
        attempt({ attemptId: id(2), chapterId: CHAPTER_B, elapsedMs: 2_000 }),
      ]);
    });
    await act(async () => {
      pending.get(CHAPTER_A)?.([
        attempt({ attemptId: id(1), chapterId: CHAPTER_A, elapsedMs: 7_000 }),
      ]);
    });
    expect(totalText()).toBe("2.00초");
  });

  it("picks up a run started while open through to its end, without reopening", async () => {
    vi.useFakeTimers();
    let records: PageWorkflowTiming[] = [];
    const load = vi.fn(async () => records);
    window.mangaApi = createTestMangaGatewayStub({
      getPageWorkflowTimings: load,
    });
    const view = render(
      <PageWorkflowTimingView chapterId={CHAPTER_A} selectedPageId={null} />,
    );
    await act(async () => undefined);
    expect(screen.getByText("기록이 없습니다.")).toBeTruthy();

    records = [
      attempt({ attemptId: id(1), chapterId: CHAPTER_A, status: "running" }),
    ];
    await act(() => vi.advanceTimersByTimeAsync(WORKFLOW_TIMING_POLL_MS));
    expect(screen.getByText("지금까지 경과")).toBeTruthy();

    records = [attempt({ attemptId: id(1), chapterId: CHAPTER_A })];
    await act(() => vi.advanceTimersByTimeAsync(WORKFLOW_TIMING_POLL_MS));
    expect(screen.getByText("실행 전체 시간")).toBeTruthy();

    const calls = load.mock.calls.length;
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(WORKFLOW_TIMING_POLL_MS * 4));
    expect(load).toHaveBeenCalledTimes(calls);
  });

  it("recovers after a failed refresh and stops polling the previous chapter", async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<(chapterId: string) => Promise<PageWorkflowTiming[]>>()
      .mockResolvedValueOnce([
        attempt({ attemptId: id(1), chapterId: CHAPTER_A }),
      ])
      .mockRejectedValueOnce(new Error("busy"))
      .mockImplementation(async (chapterId) => [
        attempt({ attemptId: id(2), chapterId, elapsedMs: 8_000 }),
      ]);
    window.mangaApi = createTestMangaGatewayStub({
      getPageWorkflowTimings: load,
    });
    const view = render(
      <PageWorkflowTimingView chapterId={CHAPTER_A} selectedPageId={null} />,
    );
    await act(async () => undefined);
    await act(() => vi.advanceTimersByTimeAsync(WORKFLOW_TIMING_POLL_MS));
    expect(screen.getByText(/갱신하지 못했습니다/)).toBeTruthy();
    expect(totalText()).toBe("3.00초");

    await act(() => vi.advanceTimersByTimeAsync(WORKFLOW_TIMING_POLL_MS));
    expect(screen.queryByText(/갱신하지 못했습니다/)).toBeNull();
    expect(totalText()).toBe("8.00초");

    view.rerender(
      <PageWorkflowTimingView chapterId={CHAPTER_B} selectedPageId={null} />,
    );
    await act(async () => undefined);
    load.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(WORKFLOW_TIMING_POLL_MS * 3));
    expect(
      load.mock.calls.every(([chapterId]) => chapterId === CHAPTER_B),
    ).toBe(true);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("offers a retry after a failed load and shows an empty state", async () => {
    const load = vi
      .fn<() => Promise<PageWorkflowTiming[]>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([]);
    window.mangaApi = createTestMangaGatewayStub({
      getPageWorkflowTimings: load,
    });
    render(
      <PageWorkflowTimingView chapterId={CHAPTER_A} selectedPageId={null} />,
    );

    expect(
      await screen.findByText("작업 기록을 불러오지 못했습니다."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("기록이 없습니다.")).toBeTruthy();
  });

  it("explains when one attempt spans several chapters", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      getPageWorkflowTimings: async () => [
        {
          ...attempt({ attemptId: id(1), chapterId: CHAPTER_A }),
          chapters: [
            { id: CHAPTER_A, title: "1화", workId: "w" },
            { id: CHAPTER_B, title: "2화", workId: "w" },
          ],
        },
      ],
    });
    render(
      <PageWorkflowTimingView chapterId={CHAPTER_A} selectedPageId={null} />,
    );
    expect(await screen.findByTitle(/다른 화도 포함/)).toBeTruthy();
    expect(screen.getByText("화 2개 · 페이지 1개")).toBeTruthy();
  });
});

function attempt({
  attemptId,
  chapterId,
  elapsedMs = 3_000,
  pages,
  stages = { ocr: 1_000 },
  startedAt = "2026-10-12T03:00:00.000Z",
  status = "completed",
}: {
  attemptId: string;
  chapterId: string;
  elapsedMs?: number;
  pages?: PageWorkflowTiming["pages"];
  stages?: PageWorkflowTiming["stages"];
  startedAt?: string;
  status?: PageWorkflowTiming["status"];
}): PageWorkflowTiming {
  return {
    version: 1,
    attemptId,
    runId: RUN,
    startedAt,
    ...(status === "running" || status === "interrupted"
      ? {}
      : { finishedAt: "2026-10-12T03:30:00.000Z" }),
    status,
    elapsedMs,
    stages,
    cleanupMs: 120,
    chapters: [{ id: chapterId, title: "1화", workId: "w" }],
    pages: pages ?? [
      {
        chapterId,
        pageId: "p1",
        pageName: "001.png",
        stages: { ocr: 800 },
        skippedStages: [],
      },
    ],
  };
}

function id(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function cells(row: HTMLElement): string[] {
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent ?? "");
}

function totalText(): string | null {
  const term = screen.getByText(/^(실행 전체 시간|지금까지 경과)$/);
  return term.nextElementSibling?.textContent ?? null;
}

function legacyPage(): MangaPage {
  return {
    id: "legacy",
    name: "legacy.png",
    imagePath: "legacy.png",
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    processingTiming: {
      version: PAGE_PROCESSING_TIMING_VERSION,
      stages: { translation: 1_200 },
      measuredAt: "2026-01-01T00:00:00.000Z",
      sessionId: "00000000-0000-4000-8000-000000000001",
      state: "completed",
      checkpoint: 1,
    },
  };
}
