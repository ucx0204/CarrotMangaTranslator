/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { GatherTextModal } from "../src/renderer/src/components/GatherTextModal";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

const gatewayMocks = {
  importReviewText: vi.fn(),
};

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub(gatewayMocks);
});

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.restoreAllMocks();
  gatewayMocks.importReviewText.mockReset();
});

describe("gather text modal", () => {
  it("shows only the gathered-text workflow without search-and-replace tabs", () => {
    const onOpenBatchEdit = vi.fn();
    render(
      <GatherTextModal
        chapter={CHAPTER}
        page={PAGE}
        onClose={vi.fn()}
        onOpenBatchEdit={onOpenBatchEdit}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "텍스트 모아보기" }),
    ).not.toBeNull();
    expect(screen.getByLabelText("텍스트 검색")).not.toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByLabelText("찾을 내용")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "텍스트 일괄 편집" }));
    expect(onOpenBatchEdit).toHaveBeenCalledOnce();
  });

  it("uses the latest chapter callback when a review import finishes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const deferred = createDeferred<{
      chapter: ChapterSnapshot;
      updatedBlockCount: number;
      warnings: string[];
    }>();
    gatewayMocks.importReviewText.mockReturnValue(deferred.promise);
    const initialCallback = vi.fn();
    const latestCallback = vi.fn();
    const view = render(
      <GatherTextModal
        chapter={CHAPTER}
        page={PAGE}
        onChapterUpdated={initialCallback}
        onClose={vi.fn()}
      />,
    );
    const reviewInput = view.container.querySelector('input[accept^=".csv"]');
    if (!(reviewInput instanceof HTMLInputElement)) {
      throw new Error("review file input is missing");
    }
    const file = new File(["review"], "review.csv", { type: "text/csv" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn(async () => new ArrayBuffer(0)),
    });

    fireEvent.change(reviewInput, { target: { files: [file] } });
    await vi.waitFor(() => {
      expect(gatewayMocks.importReviewText).toHaveBeenCalledOnce();
    });
    view.rerender(
      <GatherTextModal
        chapter={CHAPTER}
        page={PAGE}
        onChapterUpdated={latestCallback}
        onClose={vi.fn()}
      />,
    );
    deferred.resolve({
      chapter: CHAPTER,
      updatedBlockCount: 1,
      warnings: [],
    });
    await vi.waitFor(() => {
      expect(latestCallback).toHaveBeenCalledOnce();
    });

    expect(initialCallback).not.toHaveBeenCalled();
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) throw new Error("deferred resolver is missing");
      resolvePromise(value);
    },
  };
}

const TIMESTAMP = "2026-08-24T00:00:00.000Z";
const BLOCK: TranslationBlock = {
  id: "block-1",
  type: "nonsolid",
  bbox: { x: 10, y: 20, w: 200, h: 100 },
  sourceText: "こんにちは",
  translatedText: "안녕",
  confidence: 1,
  sourceDirection: "horizontal",
  renderDirection: "horizontal",
  fontSizePx: 24,
  lineHeight: 1.2,
  textAlign: "center",
  textColor: "#111111",
  backgroundColor: "#ffffff",
  opacity: 0.2,
};
const PAGE: MangaPage = {
  id: "page-1",
  name: "page-1.png",
  imagePath: "page-1.png",
  dataUrl: "",
  width: 1000,
  height: 1600,
  blocks: [BLOCK],
  analysisStatus: "idle",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const CHAPTER: ChapterSnapshot = {
  id: "chapter-1",
  workId: "work-1",
  title: "모아보기 테스트",
  sourceKind: "images",
  status: "idle",
  pageOrder: [PAGE.id],
  pages: [PAGE],
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
