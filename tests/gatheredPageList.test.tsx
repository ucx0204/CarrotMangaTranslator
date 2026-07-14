/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatheredPageList } from "../src/renderer/src/components/gatherText/GatheredPageList";
import type { GatherTextFormatSelection } from "../src/renderer/src/components/gatherText/useGatherTextFormatSelection";
import type { GatherTextSearch } from "../src/renderer/src/hooks/useGatherTextSearch";

afterEach(cleanup);

describe("GatheredPageList selection rows", () => {
  it("toggles selection when the text area is clicked", () => {
    const selection = makeSelection();
    render(
      <GatheredPageList
        pages={PAGES}
        field="both"
        search={SEARCH}
        formatSelection={selection}
      />,
    );

    fireEvent.click(screen.getByText("번역 1"));

    expect(selection.toggle).toHaveBeenCalledWith({
      pageId: "page-1",
      blockId: "block-1",
    });
  });

  it("keeps the page navigation button separate from selection", () => {
    const selection = makeSelection();
    const onNavigateToBlock = vi.fn();
    render(
      <GatheredPageList
        pages={PAGES}
        field="both"
        search={SEARCH}
        formatSelection={selection}
        onNavigateToBlock={onNavigateToBlock}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "클릭하면 해당 페이지로 이동합니다.",
      }),
    );

    expect(onNavigateToBlock).toHaveBeenCalledWith("page-1", "block-1");
    expect(selection.toggle).not.toHaveBeenCalled();
  });

  it("does not show selection controls outside selection mode", () => {
    const selection = makeSelection({ isSelectionMode: false });
    render(
      <GatheredPageList
        pages={PAGES}
        field="both"
        search={SEARCH}
        formatSelection={selection}
      />,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("keeps whole-row navigation outside selection mode", () => {
    const selection = makeSelection({ isSelectionMode: false });
    const onNavigateToBlock = vi.fn();
    render(
      <GatheredPageList
        pages={PAGES}
        field="both"
        search={SEARCH}
        formatSelection={selection}
        onNavigateToBlock={onNavigateToBlock}
      />,
    );

    fireEvent.click(screen.getByText("번역 1"));

    expect(onNavigateToBlock).toHaveBeenCalledWith("page-1", "block-1");
    expect(selection.toggle).not.toHaveBeenCalled();
  });
});

function makeSelection(
  overrides: Partial<GatherTextFormatSelection> = {},
): GatherTextFormatSelection {
  return {
    apply: vi.fn(),
    clear: vi.fn(),
    closeFormatModal: vi.fn(),
    disabled: false,
    enterSelectionMode: vi.fn(),
    exitSelectionMode: vi.fn(),
    formatModel: {
      hasSelection: false,
      previewValues: null,
      selectionCount: 0,
      values: {} as GatherTextFormatSelection["formatModel"]["values"],
    },
    isFormatModalOpen: false,
    isSelectionMode: true,
    isSelected: () => false,
    openFormatModal: vi.fn(),
    selectAllVisible: vi.fn(),
    selectedCount: 0,
    toggle: vi.fn(),
    ...overrides,
  };
}

const PAGES = [
  {
    pageId: "page-1",
    pageName: "manga.png",
    index: 0,
    blocks: [
      {
        id: "block-1",
        sourceText: "원문 1",
        translatedText: "번역 1",
      },
    ],
  },
];

const SEARCH: GatherTextSearch = {
  query: "",
  setQuery: vi.fn(),
  matchCount: 0,
  activeIndex: 0,
  activeRef: { current: null },
  handleKeyDown: vi.fn(),
};
