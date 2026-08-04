/** @vitest-environment jsdom */

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomaticFontMatchNotice } from "../src/renderer/src/components/AutomaticFontMatchNotice";
import { useUpdateSelectedBlockAction } from "../src/renderer/src/hooks/useUpdateSelectedBlockAction";
import type { UpdateCurrentChapter } from "../src/renderer/src/hooks/useCurrentChapterUpdater";
import { TranslationBlockSchema } from "../src/shared/ipcSchemaPrimitives";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

afterEach(() => cleanup());

describe("automatic font match editor UX", () => {
  it("round-trips provenance through IPC and restores the exact prior style", () => {
    const block = makeBlock();
    expect(TranslationBlockSchema.parse(block).automaticFontMatch).toEqual(
      block.automaticFontMatch,
    );
    const onUpdate = vi.fn();
    render(
      <AutomaticFontMatchNotice
        block={block}
        disabled={false}
        onUpdate={onUpdate}
      />,
    );

    expect(screen.getByText("자동 맞춤")).not.toBeNull();
    expect(screen.getByText("일반 대사")).not.toBeNull();
    expect(screen.getByText("94%")).not.toBeNull();
    expect(screen.getByText(/약하게 참고했습니다/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "자동 선택 되돌리기" }));

    expect(onUpdate).toHaveBeenCalledWith({
      automaticFontMatch: undefined,
      fontFamily: "nanum-gothic",
      bold: undefined,
      italic: false,
      outlineWidthScale: 1.25,
      textColor: "#123456",
      outlineColor: undefined,
    });
  });

  it("accepts legacy provenance without color rollback fields", () => {
    const block = makeBlock();
    const match = block.automaticFontMatch;
    if (!match) throw new Error("test provenance is required");
    const previousStyle = match.previousStyle;
    const legacy = {
      fontFamily: previousStyle.fontFamily,
      bold: previousStyle.bold,
      italic: previousStyle.italic,
      outlineWidthScale: previousStyle.outlineWidthScale,
    };
    const legacyBlock = {
      ...block,
      automaticFontMatch: { ...match, previousStyle: legacy },
    };

    expect(
      TranslationBlockSchema.parse(legacyBlock).automaticFontMatch,
    ).toEqual(legacyBlock.automaticFontMatch);
  });

  it("clears stale provenance on manual style edits and names rollback history", () => {
    const block = makeBlock();
    const chapter = makeChapter(block);
    let latest = chapter;
    const updateCurrentChapter = vi.fn<UpdateCurrentChapter>(
      (_pageId, updater) => {
        latest = updater(latest);
      },
    );
    const { result, rerender } = renderHook(
      ({ selectedBlock }: { selectedBlock: TranslationBlock }) =>
        useUpdateSelectedBlockAction({
          selectedBlock,
          selectedPage: latest.pages[0] as MangaPage,
          selectedPageEditLocked: false,
          updateCurrentChapter,
        }),
      { initialProps: { selectedBlock: block } },
    );

    act(() => result.current({ fontFamily: "dohyeon" }));
    expect(latest.pages[0]?.blocks[0]?.fontFamily).toBe("dohyeon");
    expect(latest.pages[0]?.blocks[0]?.automaticFontMatch).toBeUndefined();

    latest = makeChapter(block);
    rerender({ selectedBlock: block });
    act(() => result.current({ textColor: "#fedcba" }));
    expect(latest.pages[0]?.blocks[0]?.textColor).toBe("#fedcba");
    expect(latest.pages[0]?.blocks[0]?.automaticFontMatch).toBeUndefined();

    latest = makeChapter(block);
    rerender({ selectedBlock: block });
    act(() =>
      result.current({
        automaticFontMatch: undefined,
        fontFamily: "nanum-gothic",
        bold: undefined,
        italic: false,
        outlineWidthScale: 1.25,
      }),
    );
    expect(updateCurrentChapter.mock.calls.at(-1)?.[2]).toMatchObject({
      label: "자동 폰트 선택 되돌리기",
      mergeKey: "automatic-font-rollback:block-1",
    });
    expect(latest.pages[0]?.blocks[0]?.automaticFontMatch).toBeUndefined();
  });
});

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 320, h: 120 },
    sourceText: "こんにちは",
    translatedText: "안녕하세요",
    fontRole: "dialogue",
    fontRoleConfidence: 0.96,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontFamily: "jua",
    bold: true,
    italic: true,
    outlineWidthScale: 2,
    automaticFontMatch: {
      schemaVersion: 1,
      selectedFontId: "jua",
      role: "dialogue",
      confidence: 0.94,
      source: "episode_consistency",
      previousStyle: {
        fontFamily: "nanum-gothic",
        bold: null,
        italic: false,
        outlineWidthScale: 1.25,
        textColor: "#123456",
        outlineColor: null,
      },
    },
    fontSizePx: 24,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#f7f7f2",
    outlineColor: "#141414",
    backgroundColor: "#ffffff",
    opacity: 0.3,
    autoFitText: true,
  };
}

function makeChapter(block: TranslationBlock): ChapterSnapshot {
  const page: MangaPage = {
    id: "page-1",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [block],
    analysisStatus: "completed",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: [page.id],
    pages: [page],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
}
