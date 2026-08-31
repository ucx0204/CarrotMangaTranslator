/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatherTextModal } from "../src/renderer/src/components/GatherTextModal";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

afterEach(cleanup);

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
});

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
