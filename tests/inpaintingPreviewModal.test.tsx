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
import { InpaintingPreviewModal } from "../src/renderer/src/components/InpaintingPreviewModal";
import type { InpaintingPreviewState } from "../src/renderer/src/hooks/useInpaintingPreview";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

const TS = "2026-08-10T00:00:00.000Z";
const getPageImageDataUrl = vi.fn<(path: string) => Promise<string>>();

function makePage(imagePath: string, inpaintedImagePath?: string): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath,
    inpaintedImagePath,
    dataUrl: "",
    width: 900,
    height: 1400,
    blocks: [],
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeChapter(page: MangaPage): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: [page.id],
    pages: [page],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makePreview(): InpaintingPreviewState {
  return {
    transactionId: "transaction-1",
    chapterId: "chapter-1",
    pageId: "page-1",
    pageName: "001.png",
    beforeChapter: makeChapter(makePage("C:/before.png")),
    afterChapter: makeChapter(makePage("C:/before.png", "C:/generated.png")),
    label: "원문 지우기",
    pagesChanged: 1,
    blocksErased: 2,
    pagesIncomplete: 0,
    blocksIncomplete: 0,
  };
}

beforeEach(() => {
  getPageImageDataUrl.mockImplementation((path) =>
    Promise.resolve(
      path.includes("generated")
        ? "data:image/png;base64,after"
        : "data:image/png;base64,before",
    ),
  );
  window.mangaApi = createTestMangaGatewayStub({ getPageImageDataUrl });
});

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("InpaintingPreviewModal", () => {
  it("shows the persisted original beside the retained generated result", async () => {
    render(
      <InpaintingPreviewModal
        preview={makePreview()}
        busy={false}
        error={null}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "인페인트 결과 확인" }),
    ).toBeTruthy();
    expect(screen.getByText("적용 전 미리보기")).toBeTruthy();
    expect(screen.getByText("변경 전")).toBeTruthy();
    expect(screen.getByText("생성 결과")).toBeTruthy();

    await waitFor(() => expect(getPageImageDataUrl).toHaveBeenCalledTimes(2));
    expect(getPageImageDataUrl).toHaveBeenNthCalledWith(1, "C:/before.png");
    expect(getPageImageDataUrl).toHaveBeenNthCalledWith(2, "C:/generated.png");
    expect(
      await screen.findByAltText("001.png 인페인트 변경 전"),
    ).toHaveProperty("src", "data:image/png;base64,before");
    expect(screen.getByAltText("001.png 인페인트 생성 결과")).toHaveProperty(
      "src",
      "data:image/png;base64,after",
    );
  });

  it("keeps apply and discard as explicit decisions", () => {
    const onApply = vi.fn();
    const onDiscard = vi.fn();
    render(
      <InpaintingPreviewModal
        preview={makePreview()}
        busy={false}
        error={null}
        onApply={onApply}
        onDiscard={onDiscard}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "이 결과 적용" }));
    fireEvent.click(screen.getByRole("button", { name: "결과 버리기" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
