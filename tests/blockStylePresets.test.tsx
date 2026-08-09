/** @vitest-environment jsdom */

import React from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createBlockStylePreset,
  normalizeBlockStylePresets,
  resolveBlockStylePresetPatch,
  summarizeBlockStylePresets,
  type BlockStylePreset,
} from "../src/shared/blockStylePresets";
import type { TranslationBlock } from "../src/shared/textTypes";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { useBlockEditingActions } from "../src/renderer/src/hooks/useBlockEditingActions";
import type { UpdateCurrentChapter } from "../src/renderer/src/hooks/useCurrentChapterUpdater";
import {
  parseStoredAppSettings,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";
import { AppSettingsSchema } from "../src/shared/ipcSettingsSchemas";
import {
  PanelCommandSchema,
  PanelSyncStateSchema,
} from "../src/shared/panelBridgeSchemas";
import { FontsContext } from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";

describe("block style preset model", () => {
  it("captures only selected formatting groups and never block content or geometry", () => {
    const block = makeBlock("block-a", {
      fontFamily: "font-good",
      textColor: "#123456",
      rotationDeg: 8,
      reviewStatus: "needs_review",
      speakerId: "speaker-1",
    });
    const preset = createBlockStylePreset({
      block,
      groupIds: ["font", "color", "transform"],
      id: "style-preset:test",
      name: "효과음",
      pinned: true,
    });

    expect(preset.format).toEqual({
      fontFamily: "font-good",
      rotationDeg: 8,
      textColor: "#123456",
      textOpacity: 1,
    });
    expect(preset.format).not.toHaveProperty("bbox");
    expect(preset.format).not.toHaveProperty("translatedText");
    expect(preset.format).not.toHaveProperty("reviewStatus");
    expect(resolveBlockStylePresetPatch(preset)).not.toHaveProperty(
      "fontSizePx",
    );
  });

  it("sanitizes stored records and reports unavailable fonts", () => {
    const [preset] = normalizeBlockStylePresets([
      {
        version: 1,
        id: "style-preset:stored",
        name: " Stored ",
        pinned: false,
        groupIds: ["font", "color", "font"],
        format: {
          fontFamily: "font-missing",
          textColor: "#ABCDEF",
          bbox: { x: 0, y: 0, w: 1, h: 1 },
          translatedText: "must be ignored",
        },
      },
    ]);

    expect(preset?.name).toBe("Stored");
    expect(preset?.groupIds).toEqual(["font", "color"]);
    expect(preset?.format).toEqual({
      fontFamily: "font-missing",
      textColor: "#abcdef",
    });
    expect(
      summarizeBlockStylePresets([preset as BlockStylePreset], new Set())[0]
        ?.missingFont,
    ).toBe(true);
  });

  it("round-trips through settings normalization and rejects unsafe IPC fields", () => {
    const defaults = resolveDefaultAppSettings();
    const preset = createBlockStylePreset({
      block: makeBlock("block-a"),
      groupIds: ["color"],
      id: "style-preset:persisted",
      name: "대사",
    });
    const restored = parseStoredAppSettings(
      JSON.stringify({ ...defaults, blockStylePresets: [preset] }),
      defaults,
    );

    expect(restored.blockStylePresets).toEqual([preset]);
    expect(AppSettingsSchema.safeParse(restored).success).toBe(true);
    expect(
      AppSettingsSchema.safeParse({
        ...restored,
        blockStylePresets: [
          {
            ...preset,
            format: { ...preset.format, bbox: makeBlock("x").bbox },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates pop-out summaries and apply commands", () => {
    expect(
      PanelSyncStateSchema.parse({
        areaTranslateAvailable: false,
        areaTranslateSelecting: false,
        blockStylePresets: [
          {
            id: "style-preset:test",
            name: "대사",
            pinned: true,
            missingFont: false,
          },
        ],
        disableChapterApply: false,
        editorDisabled: false,
        selectedBlock: null,
        selectedBlockCount: 0,
        selectedPageSize: null,
        transformMode: "select",
      }).blockStylePresets,
    ).toHaveLength(1);
    expect(
      PanelCommandSchema.parse({
        type: "applyStylePreset",
        blockId: "block-a",
        presetId: "style-preset:test",
      }),
    ).toEqual({
      type: "applyStylePreset",
      blockId: "block-a",
      presetId: "style-preset:test",
    });
  });
});

describe("block style preset application", () => {
  it("updates a multi-selection in one history entry, skips a missing font, and preserves non-format data", () => {
    const first = makeBlock("block-a", {
      fontFamily: "font-good",
      automaticFontMatch: {
        schemaVersion: 1,
        selectedFontId: "font-good",
        role: "dialogue",
        confidence: 0.9,
        source: "local_visual",
        previousStyle: {
          fontFamily: null,
          bold: null,
          italic: null,
          outlineWidthScale: null,
        },
      },
      reviewStatus: "needs_review",
      speakerId: "speaker-1",
    });
    const second = makeBlock("block-b", { fontFamily: "font-good" });
    const page = makePage([first, second]);
    let latest = makeChapter(page);
    const updateCurrentChapter = vi.fn<UpdateCurrentChapter>(
      (_pageId, updater) => {
        latest = updater(latest);
      },
    );
    const pushStatus = vi.fn();
    const preset: BlockStylePreset = {
      version: 1,
      id: "style-preset:missing-font",
      name: "효과음",
      pinned: true,
      groupIds: ["font", "color", "transform"],
      format: {
        fontFamily: "font-missing",
        textColor: "#abcdef",
        rotationDeg: -8,
        textOpacity: 0.8,
      },
    };
    const { result } = renderHook(
      () =>
        useBlockEditingActions({
          availableFontIds: new Set(["font-good"]),
          blockStylePresets: [preset],
          currentChapter: latest,
          jobActive: false,
          pushStatus,
          selectedBlock: first,
          selectedBlockIds: [first.id, second.id],
          selectedPage: page,
          selectedPageEditLocked: false,
          setSelectedBlockId: vi.fn(),
          setSelectedBlockIds: vi.fn(),
          updateCurrentChapter,
        }),
      { wrapper: FontsTestProvider },
    );
    const beforeBboxes = latest.pages[0]?.blocks.map((block) => block.bbox);
    const beforeTexts = latest.pages[0]?.blocks.map((block) => ({
      sourceText: block.sourceText,
      translatedText: block.translatedText,
    }));

    act(() => result.current.applyStylePreset(preset.id));

    expect(updateCurrentChapter).toHaveBeenCalledOnce();
    expect(updateCurrentChapter.mock.calls[0]?.[2]).toMatchObject({
      label: "서식 프리셋 적용",
    });
    expect(latest.pages[0]?.blocks.map((block) => block.textColor)).toEqual([
      "#abcdef",
      "#abcdef",
    ]);
    expect(latest.pages[0]?.blocks.map((block) => block.rotationDeg)).toEqual([
      -8, -8,
    ]);
    expect(latest.pages[0]?.blocks.map((block) => block.fontFamily)).toEqual([
      "font-good",
      "font-good",
    ]);
    expect(latest.pages[0]?.blocks[0]?.automaticFontMatch).toBeUndefined();
    expect(latest.pages[0]?.blocks.map((block) => block.bbox)).toEqual(
      beforeBboxes,
    );
    expect(
      latest.pages[0]?.blocks.map((block) => ({
        sourceText: block.sourceText,
        translatedText: block.translatedText,
      })),
    ).toEqual(beforeTexts);
    expect(latest.pages[0]?.blocks[0]?.reviewStatus).toBe("needs_review");
    expect(latest.pages[0]?.blocks[0]?.speakerId).toBe("speaker-1");
    expect(pushStatus.mock.calls.flat().join(" ")).toContain(
      "찾을 수 없어 글꼴을 제외한 서식만 적용했습니다",
    );
  });
});

function FontsTestProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <FontsContext.Provider
      value={{
        baseOptions: [],
        busy: false,
        catalog: DEFAULT_BLOCK_FONT_CATALOG,
        options: [],
        registerFont: async () => undefined,
        removeFont: async () => undefined,
        savePreferences: async () => undefined,
      }}
    >
      {children}
    </FontsContext.Provider>
  );
}

function makeBlock(
  id: string,
  patch: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: id === "block-a" ? 100 : 500, y: 100, w: 220, h: 120 },
    renderBbox: { x: 90, y: 90, w: 240, h: 140 },
    sourceText: `source-${id}`,
    translatedText: `translated-${id}`,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontFamily: "font-good",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    ...patch,
  };
}

function makePage(blocks: TranslationBlock[]): MangaPage {
  return {
    id: "page-1",
    name: "page-1.png",
    imagePath: "page-1.png",
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks,
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChapter(page: MangaPage): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: [page.id],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
