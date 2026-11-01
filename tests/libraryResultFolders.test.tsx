/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { LibraryTree } from "../src/renderer/src/components/LibraryTree";
import { useAppCommands } from "../src/renderer/src/hooks/useAppCommands";
import { useLinkedWorkspaceController } from "../src/renderer/src/hooks/useLinkedWorkspaceController";
import type { LibraryContextActions } from "../src/renderer/src/hooks/libraryActionTypes";
import { dismissToast, getToasts } from "../src/renderer/src/lib/toastStore";
import type {
  ChapterSnapshot,
  LibraryChapterSummary,
  LibraryIndex,
} from "../src/shared/libraryTypes";
import type {
  LinkedWorkspaceStatus,
  OrganizeLinkedResultsRequest,
} from "../src/shared/linkedWorkspaceTypes";

const TS = "2026-10-31T00:00:00.000Z";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  for (const { id } of getToasts()) dismissToast(id);
  window.mangaApi = createTestMangaGatewayStub();
});

describe("library result folder actions", () => {
  it("organizes exactly the clicked chapter without opening it or settings", () => {
    const results = makeResults();
    const onOpenChapter = vi.fn();
    renderTree(results, { onOpenChapter, currentChapterId: "a1" });

    openMenu("A-2");
    expect(menuLabels()).toEqual([
      "결과물 보기",
      "이름 변경",
      "제목에 맞춰 폴더 이름 변경",
      "화 삭제",
    ]);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "제목에 맞춰 폴더 이름 변경" }),
    );
    expect(results.organize).toHaveBeenCalledWith({
      workId: "work-a",
      chapterId: "a2",
    });

    openMenu("A-2");
    fireEvent.click(screen.getByRole("menuitem", { name: "결과물 보기" }));
    expect(results.viewResults).toHaveBeenCalledWith("a2");
    expect(onOpenChapter).not.toHaveBeenCalled();
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("organizes one work only from the work menu", () => {
    const results = makeResults();
    renderTree(results);
    fireEvent.click(screen.getByRole("button", { name: "Alpha 작업" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "제목에 맞춰 폴더 이름 변경" }),
    );
    expect(results.organize).toHaveBeenCalledExactlyOnceWith({
      workId: "work-a",
    });
  });

  it("marks failed chapters in the row and on their work", () => {
    const results = makeResults({
      a2: { organization: { state: "failed", error: "사용 중" } },
      b1: { state: "failed", lastError: "디스크 부족" },
    });
    renderTree(results);

    expect(rowMeta("A-2")).toBe("폴더 이동 실패");
    expect(rowMeta("B-1")).toBe("자동 저장 실패");
    expect(rowMeta("A-1")).toBe("3페이지 · 완료");
    // One problem in each work, labelled on the work header itself.
    expect(screen.getAllByLabelText("결과 폴더 문제 1개")).toHaveLength(2);
  });

  it("separates preserved files from failures and opens the previous folder", () => {
    const results = makeResults({
      a1: {
        organization: { state: "idle", preservedRootPaths: ["C:/old/A-1"] },
      },
    });
    renderTree(results);

    expect(rowMeta("A-1")).toBe("이전 폴더에 파일 남음");
    expect(screen.queryByLabelText(/결과 폴더 문제/)).toBeNull();
    openMenu("A-1");
    fireEvent.click(screen.getByRole("menuitem", { name: "이전 폴더 열기" }));
    expect(results.openPreviousFolder).toHaveBeenCalledWith("a1");
  });

  it("locks only the organizing scope and leaves other works usable", () => {
    const results = makeResults({}, (target) => target?.workId === "work-a");
    renderTree(results);

    expect(rowMeta("A-1")).toBe("폴더 옮기는 중…");
    expect(rowMeta("B-1")).toBe("3페이지 · 완료");
    openMenu("A-1");
    expect(menuItem("제목에 맞춰 폴더 이름 변경").disabled).toBe(true);
    expect(menuItem("결과물 보기").disabled).toBe(false);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    openMenu("B-1");
    expect(menuItem("제목에 맞춰 폴더 이름 변경").disabled).toBe(false);
  });

  it("offers viewing but no folder repair for custom or unlinked chapters", () => {
    const results = makeResults({
      a1: { destinationKind: "custom" },
      a2: { connectionId: undefined, state: "unlinked" },
    });
    renderTree(results);

    openMenu("A-1");
    expect(menuLabels()).toEqual(["결과물 보기", "이름 변경", "화 삭제"]);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    openMenu("A-2");
    expect(menuLabels()).toEqual(["이름 변경", "화 삭제"]);
  });

  it("keeps custom and unlinked chapter rows unchanged during all-scope organization", () => {
    const results = makeResults(
      {
        a1: { destinationKind: "custom" },
        a2: { connectionId: undefined, state: "unlinked" },
      },
      () => true,
    );
    renderTree(results);
    expect(rowMeta("A-1")).toBe("3페이지 · 완료");
    expect(rowMeta("A-2")).toBe("3페이지 · 완료");
    expect(rowMeta("B-1")).toBe("폴더 옮기는 중…");
  });

  it("disables a work action while one managed chapter is moving on the backend", () => {
    renderTree(makeResults({ a1: { organization: { state: "moving" } } }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha 작업" }));
    expect(menuItem("제목에 맞춰 폴더 이름 변경").disabled).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Beta 작업" }));
    expect(menuItem("제목에 맞춰 폴더 이름 변경").disabled).toBe(false);
  });
});

describe("result folder controller", () => {
  it("runs each scope once and keeps unrelated scopes free", async () => {
    const finishers: Array<() => void> = [];
    const organize = vi.fn(
      () =>
        new Promise((resolve) =>
          finishers.push(() =>
            resolve({ moved: 1, unchanged: 0, preserved: 0, failures: [] }),
          ),
        ),
    );
    installGateway({ organizeLinkedResults: organize });
    const { result } = renderController();
    await waitFor(() => expect(result.current.statuses.size).toBe(3));

    act(() => {
      void result.current.organize({ workId: "work-a", chapterId: "a1" });
      void result.current.organize({ workId: "work-a", chapterId: "a1" });
      void result.current.organize({ workId: "work-a" });
      void result.current.organize();
      void result.current.organize({ workId: "work-b" });
    });
    expect(organize.mock.calls).toEqual([
      [{ workId: "work-a", chapterId: "a1" }],
      [{ workId: "work-b" }],
    ]);
    expect(
      result.current.isOrganizing({ workId: "work-a", chapterId: "a1" }),
    ).toBe(true);
    expect(result.current.isOrganizing({ workId: "work-a" })).toBe(true);
    expect(result.current.isOrganizing()).toBe(true);
    expect(
      result.current.isOrganizing({ workId: "work-a", chapterId: "a2" }),
    ).toBe(false);
    expect(
      result.current.isOrganizing({ workId: "work-b", chapterId: "b1" }),
    ).toBe(true);

    await act(async () => finishers.forEach((finish) => finish()));
    await waitFor(() =>
      expect(result.current.isOrganizing({ workId: "work-b" })).toBe(false),
    );
    expect(getToasts()[0]).toMatchObject({
      variant: "success",
      message: "결과 폴더 1개를 제목에 맞췄습니다.",
    });
  });

  it("summarizes partial failure and keeps thrown errors in the status log", async () => {
    const organize = vi
      .fn()
      .mockResolvedValueOnce({
        moved: 1,
        unchanged: 0,
        preserved: 0,
        failures: [{ chapterId: "a2", message: "사용 중" }],
      })
      .mockRejectedValueOnce(new Error("IPC 끊김"));
    installGateway({ organizeLinkedResults: organize });
    const pushStatus = vi.fn();
    const { result } = renderController({ pushStatus });
    await waitFor(() => expect(result.current.statuses.size).toBe(3));

    await act(() => result.current.organize({ workId: "work-a" }));
    expect(getToasts()[0]).toMatchObject({
      variant: "warn",
      message: "1개 화의 폴더를 옮기지 못했습니다.",
    });
    await act(() => result.current.organize());
    expect(organize).toHaveBeenLastCalledWith(undefined);
    // Raw IPC errors stay in the error log; users get the localized line.
    expect(pushStatus).toHaveBeenCalledWith("결과 폴더를 정리하지 못했습니다.");
    expect(getToasts()[0]).toMatchObject({ variant: "error" });
  });

  it("opens other chapters without saving the current one and opens preserved folders by chapter", async () => {
    const viewLinkedResults = vi.fn(async () => ({
      status: "opened" as const,
      syncedPages: 0,
    }));
    const openPreservedLinkedResults = vi.fn(async () => ({
      status: "failed" as const,
      message: "이전 폴더가 없습니다.",
    }));
    installGateway({ viewLinkedResults, openPreservedLinkedResults });
    const saveNow = vi.fn(async () => undefined);
    const pushStatus = vi.fn();
    const { result } = renderController({ saveNow, pushStatus });

    await act(() => result.current.viewResults("b1"));
    expect(viewLinkedResults).toHaveBeenCalledWith({ chapterId: "b1" });
    expect(saveNow).not.toHaveBeenCalled();

    await act(() => result.current.viewResults());
    expect(saveNow).toHaveBeenCalledOnce();
    expect(viewLinkedResults).toHaveBeenLastCalledWith({
      chapterId: "a1",
      currentPageId: "page-1",
    });

    await act(() => result.current.openPreviousFolder());
    expect(openPreservedLinkedResults).toHaveBeenCalledWith({
      chapterId: "a1",
    });
    expect(pushStatus).toHaveBeenCalledWith("이전 폴더가 없습니다.");
  });

  it("reports a failed status refresh after organization instead of swallowing it", async () => {
    let failRefresh = false;
    installGateway({
      listLinkedWorkspaceStatuses: async (ids: string[]) => {
        if (failRefresh) throw new Error("IPC disconnected");
        return ids.map((id) => status(id));
      },
      organizeLinkedResults: async () => ({
        moved: 0,
        unchanged: 1,
        preserved: 0,
        failures: [],
      }),
    });
    const pushStatus = vi.fn();
    const { result } = renderController({ pushStatus });
    await waitFor(() => expect(result.current.statuses.size).toBe(3));
    failRefresh = true;
    await act(() => result.current.organize({ workId: "work-a" }));
    expect(pushStatus).toHaveBeenCalledWith(
      "결과 폴더 상태를 불러오지 못했습니다.",
    );
    expect(result.current.isOrganizing()).toBe(false);
  });

  it.each([undefined, { workId: "work-a" }])(
    "marks only connected managed chapters busy for scope %j",
    async (target) => {
      let finish!: () => void;
      const organize = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({ moved: 1, unchanged: 0, preserved: 0, failures: [] });
          }),
      );
      installGateway({
        organizeLinkedResults: organize,
        listLinkedWorkspaceStatuses: async () => [
          status("a1"),
          status("a2", { destinationKind: "custom" }),
          status("b1", { connectionId: undefined, state: "unlinked" }),
        ],
      });
      const { result } = renderController();
      await waitFor(() => expect(result.current.statuses.size).toBe(3));
      act(() => {
        void result.current.organize(target);
      });
      expect(
        result.current.isOrganizing({ workId: "work-a", chapterId: "a1" }),
      ).toBe(true);
      expect(
        result.current.isOrganizing({ workId: "work-a", chapterId: "a2" }),
      ).toBe(false);
      expect(
        result.current.isOrganizing({ workId: "work-b", chapterId: "b1" }),
      ).toBe(false);
      expect(result.current.isOrganizing({ workId: "work-b" })).toBe(false);
      await act(async () => finish());
    },
  );
});

describe("result folder commands", () => {
  it("share labels and scopes between palette and menus", () => {
    const results = {
      ...makeResults(),
      status: status("a1", {
        organization: { state: "idle", preservedRootPaths: ["C:/old"] },
      }),
    };
    const { result } = renderHook(() =>
      useAppCommands({
        ...COMMAND_OPTIONS,
        currentChapter: makeChapterSnapshot(),
        linkedResults: results as never,
      }),
    );
    const palette = result.current.paletteCommands.map(({ id }) => id);
    expect(palette).toEqual(
      expect.arrayContaining([
        "view-linked-results",
        "open-previous-linked-results",
        "organize-linked-results",
        "organize-all-linked-results",
      ]),
    );
    expect(result.current.labels["organize-linked-results"]).toBe(
      "제목에 맞춰 폴더 이름 변경",
    );
    result.current.run("organize-linked-results");
    result.current.run("organize-all-linked-results");
    result.current.run("view-linked-results");
    result.current.run("open-previous-linked-results");
    expect(results.organize.mock.calls).toEqual([
      [{ workId: "work-a", chapterId: "a1" }],
      // The all scope sends no target.
      [],
    ]);
    expect(results.viewResults).toHaveBeenCalledWith("a1");
    expect(results.openPreviousFolder).toHaveBeenCalledWith("a1");
    expect(result.current.labels["open-previous-linked-results"]).toBe(
      "이전 폴더 열기",
    );
  });

  it("hides result commands for an unlinked chapter", () => {
    const { result } = renderHook(() =>
      useAppCommands({
        ...COMMAND_OPTIONS,
        currentChapter: makeChapterSnapshot(),
        linkedResults: {
          ...makeResults({}, undefined, []),
          status: null,
        } as never,
      }),
    );
    const palette = result.current.paletteCommands.map(({ id }) => id);
    expect(palette).not.toContain("view-linked-results");
    expect(palette).not.toContain("open-previous-linked-results");
    expect(palette).not.toContain("organize-linked-results");
    expect(palette).not.toContain("organize-all-linked-results");
  });
});

type StatusOverrides = Partial<Record<string, Partial<LinkedWorkspaceStatus>>>;

function status(
  chapterId: string,
  overrides: Partial<LinkedWorkspaceStatus> = {},
): LinkedWorkspaceStatus {
  return {
    chapterId,
    connectionId: `connection-${chapterId}`,
    state: "idle",
    pendingCount: 0,
    failedCount: 0,
    destinationKind: "managed",
    rootName: chapterId,
    ...overrides,
  };
}

function makeResults(
  overrides: StatusOverrides = {},
  organizing: (target?: OrganizeLinkedResultsRequest) => boolean = () => false,
  ids = ["a1", "a2", "b1"],
) {
  return {
    statuses: new Map(
      ids.map((id) => [id, status(id, overrides[id])] as const),
    ),
    isOrganizing: vi.fn(organizing),
    viewResults: vi.fn(async () => undefined),
    openPreviousFolder: vi.fn(async () => undefined),
    organize: vi.fn(async () => undefined),
  } satisfies NonNullable<LibraryContextActions["results"]>;
}

function renderTree(
  results: ReturnType<typeof makeResults>,
  overrides: Partial<React.ComponentProps<typeof LibraryTree>> = {},
) {
  return render(
    <LibraryTree
      collapsed={false}
      currentChapterId={null}
      jobActive={false}
      library={makeLibrary()}
      otherPanelCollapsed={false}
      onOpenChapter={vi.fn()}
      onRenameChapter={vi.fn()}
      onRenameWork={vi.fn()}
      onReorderChapter={vi.fn()}
      onToggleOtherPanel={vi.fn()}
      contextActions={{
        selection: { work: null, busy: false, open: vi.fn() } as never,
        openContext: vi.fn(),
        deleteTarget: vi.fn(),
        results,
      }}
      {...overrides}
    />,
  );
}

function openMenu(chapterTitle: string): void {
  fireEvent.click(screen.getByRole("button", { name: `${chapterTitle} 작업` }));
}

function menuLabels(): string[] {
  return screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");
}

function menuItem(name: string): HTMLButtonElement {
  return screen.getByRole("menuitem", { name }) as HTMLButtonElement;
}

function rowMeta(chapterTitle: string): string {
  const button = screen.getByText(chapterTitle).closest("button");
  if (!button) throw new Error("Missing chapter button");
  return (
    within(button).getByText((_, element) => element?.tagName === "SMALL")
      .textContent ?? ""
  );
}

function renderController(
  overrides: Partial<Parameters<typeof useLinkedWorkspaceController>[0]> = {},
) {
  const library = makeLibrary();
  const currentChapter = makeChapterSnapshot();
  const pushStatus = vi.fn();
  const saveNow = vi.fn(async () => undefined);
  return renderHook(() =>
    useLinkedWorkspaceController({
      currentChapter,
      currentPageId: "page-1",
      library,
      pushStatus,
      saveNow,
      ...overrides,
    }),
  );
}

function installGateway(overrides: Record<string, unknown>): void {
  window.mangaApi = createTestMangaGatewayStub({
    listLinkedWorkspaceStatuses: async (ids: string[]) =>
      ids.map((id) => status(id)),
    onLinkedWorkspaceStatusChanged: () => () => undefined,
    ...overrides,
  });
}

const COMMAND_OPTIONS = {
  jobActive: false,
  runAnalysis: vi.fn(),
  openTranslateOptions: vi.fn(),
  runCurrentPageInpainting: vi.fn(),
  cancelJob: vi.fn(),
  openImportPreview: async () => undefined,
  openShareImportPreview: async () => undefined,
  openSettings: vi.fn(),
  openLibraryFolder: vi.fn(),
  openLogFolder: vi.fn(),
  openErrorReport: vi.fn(),
  openTranslationSource: vi.fn(),
  openShareExport: vi.fn(),
  openShortcutHelp: vi.fn(),
  openTextView: vi.fn(),
  toggleBlockChrome: vi.fn(),
  toggleTextBlocks: vi.fn(),
};

function makeChapterSnapshot(): ChapterSnapshot {
  return {
    id: "a1",
    workId: "work-a",
    title: "A-1",
    sourceKind: "folder",
    status: "completed",
    pageOrder: [],
    pages: [],
    createdAt: TS,
    updatedAt: TS,
  } as ChapterSnapshot;
}

function makeLibrary(): LibraryIndex {
  return {
    workOrder: ["work-a", "work-b"],
    works: [
      work("work-a", "Alpha", [
        chapter("a1", "work-a", "A-1"),
        chapter("a2", "work-a", "A-2"),
      ]),
      work("work-b", "Beta", [chapter("b1", "work-b", "B-1")]),
    ],
  };
}

function work(
  id: string,
  title: string,
  chapters: LibraryChapterSummary[],
): LibraryIndex["works"][number] {
  return {
    id,
    title,
    chapterOrder: chapters.map((entry) => entry.id),
    chapters,
    createdAt: TS,
    updatedAt: TS,
  };
}

function chapter(
  id: string,
  workId: string,
  title: string,
): LibraryChapterSummary {
  return {
    id,
    workId,
    title,
    status: "completed",
    pageCount: 3,
    createdAt: TS,
    updatedAt: TS,
  };
}
