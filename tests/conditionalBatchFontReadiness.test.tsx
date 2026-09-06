/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  useConditionalBatchEditorModel,
  type ConditionalBatchEditorModelProps,
} from "../src/renderer/src/components/useConditionalBatchEditorModel";
import {
  clearBlockFontLoadCache,
  loadBlockFonts,
} from "../src/renderer/src/lib/blockFontLoading";
import {
  createConditionalBatchFontSizeResolver,
  createConditionalBatchTypographyLoadKey,
} from "../src/renderer/src/lib/conditionalBatchTypography";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import { applyConditionalBatchSequencePreview } from "../src/shared/conditionalBatchEngine";
import {
  batchChapter,
  BatchFonts,
  installBatchGateway,
  settleBatch,
  sizeDraft,
} from "./fixtures/conditionalBatch";

afterEach(() => {
  cleanup();
  clearBlockFontLoadCache(document);
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "fonts");
  Reflect.deleteProperty(window, "mangaApi");
});

function sourceMatchedChapter() {
  const chapter = batchChapter();
  chapter.pages[0].blocks = chapter.pages[0].blocks.slice(0, 1);
  Object.assign(chapter.pages[0].blocks[0], {
    translatedText: "캐시 검증 표본",
    fontFamily: "mongtori",
    fontSizePx: 60,
    fontSizeIntent: "source-match",
    sourceFontFacePx: 18,
    sourceFontSizeConfidence: 1,
    sourceFontSizeMethod: "raster-core-v1",
    bbox: { x: 10, y: 10, w: 900, h: 800 },
  });
  return chapter;
}

function controlledMetrics(isTargetLoaded: () => boolean) {
  const unloaded: string[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        font: "",
        measureText(this: { font: string }, text: string) {
          const size = Number(/([\d.]+)px/u.exec(this.font)?.[1] ?? 16);
          const isTarget = this.font.includes("MGT Ridi Batang");
          if (isTarget && !isTargetLoaded()) unloaded.push(this.font);
          const ratio = isTarget && !isTargetLoaded() ? 0.5 : 1;
          return {
            width: [...text].length * size * ratio,
            actualBoundingBoxAscent: size * ratio * 0.8,
            actualBoundingBoxDescent: size * ratio * 0.2,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: size * ratio,
          };
        },
      }) as never,
  );
  return unloaded;
}

function fontThenSizeSnapshot() {
  const first = sizeDraft();
  first.actions = [
    {
      id: "font",
      enabled: true,
      type: "setFields",
      changes: [
        { field: "fontFamily", operation: "set", value: "ridi-batang" },
      ],
    },
  ];
  const second = sizeDraft(40);
  second.match = {
    mode: "all",
    groups: [],
    conditions: [
      {
        id: "small",
        enabled: true,
        field: "fontSizePx",
        operator: "lessThan",
        value: 25,
      },
    ],
  };
  return {
    schemaVersion: 1 as const,
    schemes: [
      { id: "font", ...first },
      { id: "size", ...second },
    ],
    sequences: [
      {
        id: "seq",
        name: "글꼴 후 글자 키우기",
        description: "",
        steps: [
          { id: "s1", schemeId: "font", enabled: true },
          { id: "s2", schemeId: "size", enabled: true },
        ],
      },
    ],
  };
}

it("waits for intermediate fonts before measuring and applying the next size rule", async () => {
  let targetLoaded = false;
  const pending: Array<(faces: FontFace[]) => void> = [];
  const fontLoad = vi.fn((css: string) =>
    css.includes("MGT Ridi Batang")
      ? new Promise<FontFace[]>((resolve) => pending.push(resolve))
      : Promise.resolve([{} as FontFace]),
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: fontLoad },
  });
  const unloaded = controlledMetrics(() => targetLoaded);
  const chapter = sourceMatchedChapter();
  installBatchGateway(fontThenSizeSnapshot());
  const onApplySequence = vi.fn<
    NonNullable<ConditionalBatchEditorModelProps["onApplySequence"]>
  >((sequence, snapshot, preview, excluded, options) =>
    applyConditionalBatchSequencePreview(
      chapter,
      sequence,
      snapshot,
      preview,
      excluded,
      undefined,
      options,
    ),
  );
  const props = {
    chapter,
    selectedPageId: "page",
    workspaceProps: {} as ConditionalBatchEditorModelProps["workspaceProps"],
    busy: false,
    canUndo: false,
    undoLabel: null,
    onApply: vi.fn(),
    onApplySequence,
    onClose: vi.fn(),
    onSelectPage: vi.fn(),
    onUndo: async () => false,
  } satisfies ConditionalBatchEditorModelProps;
  const h = renderHook(() => useConditionalBatchEditorModel(props), {
    wrapper: BatchFonts,
  });
  await settleBatch();
  expect(h.result.current.footerProps.busy).toBe(false);
  await act(async () => {
    h.result.current.rulePanelProps.onPreviewSequence("seq");
  });
  expect(h.result.current.footerProps.busy).toBe(true);
  expect(pending.length).toBe(4);
  expect(unloaded).toEqual([]);
  act(() => h.result.current.footerProps.onApply());
  expect(onApplySequence).not.toHaveBeenCalled();
  await act(async () => {
    targetLoaded = true;
    pending.forEach((resolve) => resolve([{} as FontFace]));
  });
  expect(h.result.current.footerProps.busy).toBe(false);
  expect(
    h.result.current.resultsProps.preview.results[0].afterBlock.fontSizePx,
  ).toBe(40);
  act(() => h.result.current.footerProps.onApply());
  expect(
    onApplySequence.mock.calls[0][2].preview.results[0].afterBlock.fontSizePx,
  ).toBe(40);
  expect(onApplySequence.mock.results[0].value.appliedCount).toBe(1);
  expect(unloaded).toEqual([]);
});

it("invalidates cached fallback face ratios after font loading and catalog refresh", async () => {
  let targetLoaded = false;
  controlledMetrics(() => targetLoaded);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      load: async () => {
        targetLoaded = true;
        return [{} as FontFace];
      },
    },
  });
  const chapter = sourceMatchedChapter();
  const block = chapter.pages[0].blocks[0];
  block.fontFamily = "ridi-batang";
  const measure = () =>
    createConditionalBatchFontSizeResolver(DEFAULT_BLOCK_FONT_CATALOG)(
      block,
      chapter.pages[0],
    );
  expect(measure()).toBe(38);
  await loadBlockFonts(document, [block], DEFAULT_BLOCK_FONT_CATALOG);
  expect(measure()).toBe(19);
  targetLoaded = false;
  clearBlockFontLoadCache(document);
  expect(measure()).toBe(38);
});

it("loads faces declared in conditional actions even when they are absent from the chapter", () => {
  const chapter = sourceMatchedChapter();
  const draft = sizeDraft();
  draft.actions = [
    {
      id: "font",
      enabled: true,
      type: "setFields",
      changes: [{ field: "fontFamily", operation: "clear" }],
    },
    {
      id: "inline",
      enabled: true,
      type: "styleText",
      target: "translatedText",
      scope: "allText",
      allOccurrences: true,
      styleMode: "overwrite",
      patch: { fontFamily: "ridi-batang" },
    },
    {
      id: "text",
      enabled: true,
      type: "setFields",
      changes: [
        {
          field: "translatedText",
          operation: "set",
          value: "기본 [font=nanum-myeongjo]명조[/font]",
        },
      ],
    },
  ];
  const key = createConditionalBatchTypographyLoadKey(
    chapter,
    [draft],
    DEFAULT_BLOCK_FONT_CATALOG,
  );
  expect(key).toContain("MGT Ridi Batang");
  expect(key).toContain("MGT Nanum Myeongjo");
  expect(key).toContain("italic 800");
  expect(key).toContain("normal 400");
});

it("prepares preset faces and skips disabled actions without requesting unrelated fonts", () => {
  const chapter = sourceMatchedChapter();
  const draft = sizeDraft();
  draft.actions = [
    {
      id: "preset",
      enabled: true,
      type: "applyStylePreset",
      presetId: "preset",
      presetName: "명조",
      groupIds: ["font"],
      format: { fontFamily: "nanum-myeongjo" },
    },
    {
      id: "disabled",
      enabled: false,
      type: "setFields",
      changes: [
        { field: "fontFamily", operation: "set", value: "ridi-batang" },
      ],
    },
    {
      id: "clear-inline",
      enabled: true,
      type: "styleText",
      target: "translatedText",
      scope: "allText",
      allOccurrences: true,
      styleMode: "overwrite",
      patch: { fontFamily: null },
    },
  ];
  const key = createConditionalBatchTypographyLoadKey(
    chapter,
    [draft],
    DEFAULT_BLOCK_FONT_CATALOG,
  );
  expect(key).toContain("MGT Nanum Myeongjo");
  expect(key).not.toContain("MGT Ridi Batang");
});

it("does not request fonts when a chapter contains no blocks to edit", () => {
  const chapter = sourceMatchedChapter();
  chapter.pages[0].blocks = [];
  expect(
    createConditionalBatchTypographyLoadKey(
      chapter,
      fontThenSizeSnapshot().schemes,
      DEFAULT_BLOCK_FONT_CATALOG,
    ),
  ).toBe("[]");
});
