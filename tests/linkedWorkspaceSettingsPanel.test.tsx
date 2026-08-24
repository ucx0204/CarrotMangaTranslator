// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { LinkedWorkspaceSettingsPanel } from "../src/renderer/src/components/settingsModal/LinkedWorkspaceSettingsPanel";
import type { LibraryIndex } from "../src/shared/libraryTypes";
import type { LinkedWorkspaceStatus } from "../src/shared/linkedWorkspaceTypes";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_WORK_ID = "55555555-5555-4555-8555-555555555555";
const FIRST_CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_CHAPTER_ID = "33333333-3333-4333-8333-333333333333";
const THIRD_CHAPTER_ID = "66666666-6666-4666-8666-666666666666";
const CONNECTION_ID = "44444444-4444-4444-8444-444444444444";
const listStatuses =
  vi.fn<(ids: string[]) => Promise<LinkedWorkspaceStatus[]>>();
const updateConnection = vi.fn();
const connect = vi.fn();
const reconnect = vi.fn();
const resetLocation = vi.fn();
const viewResults = vi.fn();

beforeEach(() => {
  listStatuses.mockResolvedValue([
    {
      chapterId: FIRST_CHAPTER_ID,
      connectionId: CONNECTION_ID,
      state: "idle",
      pendingCount: 0,
      failedCount: 0,
      rootPath: "C:/manga/work",
      rootName: "work",
      destinationKind: "custom",
      outputFormat: "source",
    },
    {
      chapterId: SECOND_CHAPTER_ID,
      state: "unlinked",
      pendingCount: 0,
      failedCount: 0,
    },
  ]);
  updateConnection.mockResolvedValue(undefined);
  connect.mockResolvedValue(undefined);
  reconnect.mockResolvedValue(undefined);
  resetLocation.mockResolvedValue(undefined);
  viewResults.mockResolvedValue({ status: "opened", syncedPages: 0 });
  window.mangaApi = createTestMangaGatewayStub({
    listLinkedWorkspaceStatuses: listStatuses,
    onLinkedWorkspaceStatusChanged: () => () => undefined,
    updateLinkedWorkspace: updateConnection,
    connectLinkedWorkspace: connect,
    reconnectLinkedWorkspace: reconnect,
    resetLinkedWorkspaceLocation: resetLocation,
    viewLinkedResults: viewResults,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.mangaApi = createTestMangaGatewayStub();
});

describe("LinkedWorkspaceSettingsPanel", () => {
  it("lists every work/chapter and toggles each chapter independently", async () => {
    render(<LinkedWorkspaceSettingsPanel library={makeLibrary()} />);
    expect(await screen.findByText("테스트 작품")).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "1화 결과물 자동 저장" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "2화 결과물 자동 저장" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "1화 결과물 자동 저장" }),
    );
    await waitFor(() =>
      expect(updateConnection).toHaveBeenCalledWith({
        connectionId: CONNECTION_ID,
        enabled: false,
      }),
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "2화 결과물 자동 저장" }),
    );
    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith(
        expect.objectContaining({
          workId: WORK_ID,
          chapterId: SECOND_CHAPTER_ID,
          output: expect.objectContaining({
            format: "source",
            destinationMode: "fixed",
          }),
        }),
      ),
    );
  });

  it("offers result viewing and save-location controls without source-folder concepts", async () => {
    render(<LinkedWorkspaceSettingsPanel library={makeLibrary()} />);
    await screen.findByText(/사용자 지정 폴더/);
    fireEvent.click(
      screen.getByRole("button", { name: "자동 저장 작업 더 보기" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "결과물 보기" }));
    await waitFor(() =>
      expect(viewResults).toHaveBeenCalledWith({
        chapterId: FIRST_CHAPTER_ID,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "자동 저장 작업 더 보기" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "저장 위치 변경" }));
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith(CONNECTION_ID));

    fireEvent.click(
      screen.getByRole("button", { name: "자동 저장 작업 더 보기" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "기본 위치로 되돌리기" }),
    );
    await waitFor(() =>
      expect(resetLocation).toHaveBeenCalledWith(CONNECTION_ID),
    );
  });

  it("searches works and chapters and supports library-style sorting", async () => {
    const { container } = render(
      <LinkedWorkspaceSettingsPanel library={makeLibrary()} />,
    );
    await screen.findByText("테스트 작품");

    fireEvent.change(screen.getByPlaceholderText("작품/화 검색"), {
      target: { value: "특별화" },
    });
    expect(await screen.findByText("특별화")).toBeTruthy();
    expect(screen.getByText("가나다 작품")).toBeTruthy();
    expect(screen.queryByText("테스트 작품")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("작품/화 검색"), {
      target: { value: "없는 작품" },
    });
    expect(await screen.findByText("검색 결과가 없습니다.")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("작품/화 검색"), {
      target: { value: "" },
    });
    await screen.findByText("테스트 작품");
    fireEvent.click(screen.getByRole("button", { name: /정렬:/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "이름" }));
    fireEvent.click(screen.getByRole("button", { name: "오름차순" }));

    expect(
      Array.from(
        container.querySelectorAll(".linked-workspace-work-header strong"),
      ).map((element) => element.textContent),
    ).toEqual(["가나다 작품", "테스트 작품"]);
  });
});

function makeLibrary(): LibraryIndex {
  const timestamp = "2026-08-24T00:00:00.000Z";
  return {
    workOrder: [WORK_ID, SECOND_WORK_ID],
    works: [
      {
        id: WORK_ID,
        title: "테스트 작품",
        chapterOrder: [FIRST_CHAPTER_ID, SECOND_CHAPTER_ID],
        chapters: [
          makeChapterSummary(FIRST_CHAPTER_ID, "1화", timestamp),
          makeChapterSummary(SECOND_CHAPTER_ID, "2화", timestamp),
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: SECOND_WORK_ID,
        title: "가나다 작품",
        chapterOrder: [THIRD_CHAPTER_ID],
        chapters: [
          makeChapterSummary(
            THIRD_CHAPTER_ID,
            "특별화",
            "2026-08-20T00:00:00.000Z",
            SECOND_WORK_ID,
          ),
        ],
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ],
  };
}

function makeChapterSummary(
  id: string,
  title: string,
  timestamp: string,
  workId = WORK_ID,
) {
  return {
    id,
    workId,
    title,
    status: "completed" as const,
    pageCount: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
