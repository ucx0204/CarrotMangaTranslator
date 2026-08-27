/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import { PageList } from "../src/renderer/src/components/PageList";

afterEach(cleanup);

describe("page timing dialog", () => {
  it("opens from the timer button beside the filter and shows reconciled totals", () => {
    render(
      <PageList
        collapsed={false}
        otherPanelCollapsed={false}
        pages={PAGES}
        selectedPageId={null}
        jobActive={false}
        onSelect={vi.fn()}
        onRetranslate={vi.fn()}
        onRemove={vi.fn()}
        onReorder={vi.fn()}
        onToggleOtherPanel={vi.fn()}
      />,
    );

    const filter = screen.getByRole("button", {
      name: "페이지 상태 필터: 전체",
    });
    const timer = screen.getByRole("button", { name: "페이지 소요 시간" });
    expect(
      filter.compareDocumentPosition(timer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(timer);
    const dialog = screen.getByRole("dialog", { name: "페이지별 소요 시간" });
    expect(
      within(dialog).getAllByText("전체 총 소요 시간").length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("9초").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("001.jpg")).not.toBeNull();
    expect(within(dialog).getByText("002.jpg")).not.toBeNull();
    expect(
      within(dialog).getByRole("columnheader", { name: "OCR" }),
    ).not.toBeNull();
    expect(
      within(dialog).getByRole("columnheader", { name: "AI 번역" }),
    ).not.toBeNull();
    expect(
      within(dialog).getByRole("columnheader", { name: "인페인팅" }),
    ).not.toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(
      screen.queryByRole("dialog", { name: "페이지별 소요 시간" }),
    ).toBeNull();
  });
});

const PAGES: MangaPage[] = [
  timedPage("a", "001.jpg", {
    ocr: 1_600,
    translation: 2_600,
    typography: 800,
  }),
  timedPage("b", "002.jpg", {
    preparing: 600,
    translation: 1_400,
    inpainting: 1_600,
    bubbleLayout: 400,
  }),
];

function timedPage(
  id: string,
  name: string,
  stages: NonNullable<MangaPage["processingTiming"]>["stages"],
): MangaPage {
  return {
    id,
    name,
    imagePath: name,
    dataUrl:
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    width: 1,
    height: 1,
    blocks: [],
    analysisStatus: "completed",
    processingTiming: {
      version: 1,
      stages,
      measuredAt: "2026-08-27T00:00:00.000Z",
    },
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}
