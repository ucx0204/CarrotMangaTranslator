/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatherTextModal } from "../src/renderer/src/components/GatherTextModal";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { GatherTextTab } from "../src/renderer/src/lib/gatherText";
import type { TranslationBlock } from "../src/shared/textTypes";

afterEach(cleanup);

describe("gather text search-and-replace tab", () => {
  it("switches between the overview and the integrated search tab", () => {
    render(<StatefulGatherTextModal />);

    expect(
      screen.getByRole("dialog", { name: "텍스트 모아보기" }),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("tab", { name: "모아보기" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByLabelText("텍스트 검색")).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "검색·치환" }));

    expect(screen.queryByRole("dialog", { name: "검색 및 치환" })).toBeNull();
    expect(screen.getByLabelText("찾을 내용")).not.toBeNull();
    expect(screen.queryByLabelText("텍스트 검색")).toBeNull();
    expect(screen.queryByRole("button", { name: "복사" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "모아보기" }));
    expect(screen.getByLabelText("텍스트 검색")).not.toBeNull();
  });

  it("previews and applies replacement without closing the gather-text modal", () => {
    const onApplySearchReplace = vi.fn();
    render(
      <GatherTextModal
        activeTab="search-replace"
        chapter={chapter}
        page={page}
        onApplySearchReplace={onApplySearchReplace}
        onClose={vi.fn()}
        onTabChange={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("찾을 내용"), {
      target: { value: "안녕" },
    });
    fireEvent.change(screen.getByLabelText("바꿀 내용"), {
      target: { value: "반가워" },
    });

    expect(screen.getByText("1곳 일치")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "모두 치환 (1)" }));

    expect(onApplySearchReplace).toHaveBeenCalledWith(
      expect.objectContaining({
        field: "translated",
        query: "안녕",
        replacement: "반가워",
        scope: "page",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "텍스트 모아보기" }),
    ).not.toBeNull();
    expect(screen.getByLabelText("찾을 내용")).toHaveProperty("value", "안녕");
  });
});

function StatefulGatherTextModal(): React.JSX.Element {
  const [tab, setTab] = React.useState<GatherTextTab>("overview");
  return (
    <GatherTextModal
      activeTab={tab}
      chapter={chapter}
      page={page}
      onApplySearchReplace={vi.fn()}
      onClose={vi.fn()}
      onTabChange={setTab}
    />
  );
}

const timestamp = "2026-08-24T00:00:00.000Z";
const block: TranslationBlock = {
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
const page: MangaPage = {
  id: "page-1",
  name: "page-1.png",
  imagePath: "page-1.png",
  dataUrl: "",
  width: 1000,
  height: 1600,
  blocks: [block],
  analysisStatus: "idle",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const chapter: ChapterSnapshot = {
  id: "chapter-1",
  workId: "work-1",
  title: "통합 검색 테스트",
  sourceKind: "images",
  status: "idle",
  pageOrder: [page.id],
  pages: [page],
  createdAt: timestamp,
  updatedAt: timestamp,
};
