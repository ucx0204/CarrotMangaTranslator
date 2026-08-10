/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { ChapterTaskHeader } from "../src/renderer/src/components/ChapterTaskHeader";

const chapter = {
  id: "chapter-22",
  workId: "work-1",
  title: "22화",
  sourceKind: "images",
  status: "idle",
  pageOrder: [],
  pages: [],
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
} satisfies ChapterSnapshot;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ChapterTaskHeader", () => {
  it("shows the saved state beside the title, then hides it", () => {
    vi.useFakeTimers();
    const { container } = render(
      <ChapterTaskHeader
        currentChapter={chapter}
        saveStatus="saved"
        onRetrySave={vi.fn()}
      />,
    );

    const titleGroup = container.querySelector(".chapter-task-title");
    expect(titleGroup?.contains(screen.getByText("22화"))).toBe(true);
    expect(titleGroup?.contains(screen.getByText("저장됨"))).toBe(true);
    expect(container.querySelector(".chapter-save-status")).toBeNull();

    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByText("저장됨")).toBeNull();
  });

  it.each([
    ["dirty", "저장 대기 중"],
    ["saving", "저장 중…"],
  ] as const)("shows %s beside the title", (saveStatus, label) => {
    const { container } = render(
      <ChapterTaskHeader
        currentChapter={chapter}
        saveStatus={saveStatus}
        onRetrySave={vi.fn()}
      />,
    );

    const titleGroup = container.querySelector(".chapter-task-title");
    expect(titleGroup?.contains(screen.getByText(label))).toBe(true);
    expect(container.querySelector(".chapter-save-status")).toBeNull();
    expect(
      container.querySelector(`.chapter-save-badge.${saveStatus}`),
    ).not.toBeNull();
  });

  it("keeps actionable save errors in the full-width feedback row", () => {
    const onRetrySave = vi.fn();
    const { container } = render(
      <ChapterTaskHeader
        currentChapter={chapter}
        saveStatus="error"
        onRetrySave={onRetrySave}
      />,
    );

    expect(
      container.querySelector(".chapter-save-status.error"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "다시 저장" }));
    expect(onRetrySave).toHaveBeenCalledOnce();
  });
});
