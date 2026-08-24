// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useLinkedWorkspaceActivityReporter } from "../src/renderer/src/hooks/useLinkedWorkspaceActivityReporter";

const CHAPTER_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const reportActivity = vi.fn().mockResolvedValue({ completed: true });
const listStatuses = vi.fn();

beforeEach(() => {
  listStatuses.mockResolvedValue([]);
  window.mangaApi = createTestMangaGatewayStub({
    listLinkedWorkspaceStatuses: listStatuses,
    onLinkedWorkspaceStatusChanged: () => () => undefined,
    reportLinkedWorkspaceActivity: reportActivity,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.mangaApi = createTestMangaGatewayStub();
});

describe("linked workspace activity reporter", () => {
  it("does not add editor IPC traffic when every chapter is unlinked", async () => {
    render(<Reporter chapterIds={[CHAPTER_ID]} />);
    await waitFor(() => expect(listStatuses).toHaveBeenCalled());
    reportActivity.mockClear();
    fireEvent.pointerDown(window);
    fireEvent.input(window);
    fireEvent.pointerUp(window);
    await act(async () => Promise.resolve());
    expect(reportActivity).not.toHaveBeenCalled();
  });

  it("reports pointer, IME, and ordinary input activity for active connections", async () => {
    listStatuses.mockResolvedValue([
      {
        chapterId: CHAPTER_ID,
        connectionId: CONNECTION_ID,
        state: "idle",
        pendingCount: 0,
        failedCount: 0,
      },
    ]);
    render(<Reporter chapterIds={[CHAPTER_ID]} />);
    await waitFor(() => expect(listStatuses).toHaveBeenCalled());
    fireEvent.pointerDown(window);
    fireEvent.compositionStart(window);
    fireEvent.input(window);
    fireEvent.compositionEnd(window);
    fireEvent.pointerUp(window);
    await waitFor(() => {
      expect(reportActivity).toHaveBeenCalledWith({
        type: "start",
        interaction: "pointer",
      });
      expect(reportActivity).toHaveBeenCalledWith({
        type: "end",
        interaction: "composition",
      });
      expect(reportActivity).toHaveBeenCalledWith({ type: "pulse" });
    });
  });

  it("always protects a detached editor window without querying the library", async () => {
    render(<Reporter chapterIds={null} />);
    fireEvent.pointerDown(window);
    await waitFor(() =>
      expect(reportActivity).toHaveBeenCalledWith({
        type: "start",
        interaction: "pointer",
      }),
    );
    expect(listStatuses).not.toHaveBeenCalled();
  });
});

function Reporter({
  chapterIds,
}: {
  chapterIds: readonly string[] | null;
}): null {
  useLinkedWorkspaceActivityReporter(chapterIds);
  return null;
}
