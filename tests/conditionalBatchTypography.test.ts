import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConditionalBatchFontSizeResolver } from "../src/renderer/src/lib/conditionalBatchTypography";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import {
  applyConditionalBatchPreview,
  applyConditionalBatchSequencePreview,
  createConditionalBatchPreview,
  createConditionalBatchSequencePreview,
} from "../src/shared/conditionalBatchEngine";
import {
  ConditionalBatchSchemeDraftV2Schema,
  type ConditionalBatchActionV2,
  type ConditionalBatchSchemeDraftV2,
} from "../src/shared/conditionalBatchRules";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

beforeEach(() => {
  vi.stubGlobal("document", {
    createElement: () => ({
      getContext: () => ({
        font: "",
        measureText(this: { font: string }, text: string) {
          const size = Number(/([\d.]+)px/u.exec(this.font)?.[1] ?? 16);
          return {
            width: Array.from(text).length * size,
            actualBoundingBoxAscent: size * 0.8,
            actualBoundingBoxDescent: size * 0.2,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: size,
          };
        },
      }),
    }),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("conditional batch typography", () => {
  it("matches rendered small text throughout a chapter, even when its stored seed is 25 or larger", () => {
    const chapter = makeChapter([
      makeBlock({ id: "small-8", sourceFontFacePx: 11, fontSizePx: 32 }),
      makeBlock({ id: "small-9", sourceFontFacePx: 18, fontSizePx: 25 }),
      makeBlock({ id: "large", sourceFontFacePx: 35, fontSizePx: 8 }),
      makeBlock({ id: "manual", fontSizeIntent: "manual", fontSizePx: 27.5 }),
    ]);
    const original = structuredClone(chapter);
    const options = makeOptions();
    const rule = resizeRule();
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      rule,
      options,
    );
    expect(preview.results.map((result) => result.blockId)).toEqual([
      "small-8",
      "small-9",
    ]);
    for (const result of preview.results) {
      expect(result.conditionEvaluations[0]?.rawValue).toBeLessThan(25);
      expect(result.resolvedFieldValues?.fontSizePx?.before).toBeLessThan(25);
      expect(result.resolvedFieldValues?.fontSizePx?.after).toBe(25);
    }
    const applied = applyConditionalBatchPreview(
      chapter,
      rule,
      preview,
      new Set(),
      undefined,
      options,
    );
    expect(applied.appliedCount).toBe(2);
    expect(applied.conflictCount).toBe(0);
    expect(applied.dirtyPageIds).toEqual(["page-0", "page-1"]);
    expect(
      createConditionalBatchPreview(
        applied.chapter,
        { kind: "chapter" },
        rule,
        options,
      ).matchedCount,
    ).toBe(0);
    expect(applied.chapter.pages[2]).toEqual(chapter.pages[2]);
    expect(applied.chapter.pages[3]).toEqual(chapter.pages[3]);
    expect(chapter).toEqual(original);
  });

  it.each([false, true, undefined])(
    "makes an explicit size authoritative when autoFitText was %s",
    (autoFitText) => {
      const chapter = makeChapter([makeBlock({ fontSizePx: 25, autoFitText })]);
      const rule = resizeRule(true);
      const preview = createConditionalBatchPreview(
        chapter,
        { kind: "chapter" },
        rule,
      );
      expect(preview.results[0]?.changedFields).toContain("fontSizePx");
      expect(preview.results[0]?.afterBlock).toMatchObject({
        fontSizePx: 25,
        autoFitText: false,
        fontSizeIntent: "manual",
      });
      expect(
        applyConditionalBatchPreview(chapter, rule, preview, new Set())
          .appliedCount,
      ).toBe(1);
    },
  );

  it.each([true, false])(
    "respects an explicit auto-fit action regardless of field order (%s)",
    (reverse) => {
      const rule = resizeRule(true);
      const action = rule.actions[0];
      if (action?.type !== "setFields") throw new Error("Missing size action");
      action.changes.push({
        field: "autoFitText",
        operation: "set",
        value: true,
      });
      if (reverse) action.changes.reverse();
      const preview = createConditionalBatchPreview(
        makeChapter([makeBlock()]),
        { kind: "chapter" },
        rule,
      );
      expect(preview.results[0]?.afterBlock).toMatchObject({
        fontSizePx: 25,
        autoFitText: true,
        fontSizeIntent: "manual",
      });
    },
  );

  it("disables source matching even if the explicit auto-fit value is already false", () => {
    const rule = resizeRule(true);
    rule.actions = [
      {
        id: "fit",
        type: "setFields",
        enabled: true,
        changes: [{ field: "autoFitText", operation: "set", value: false }],
      },
    ];
    const chapter = makeChapter([makeBlock()]);
    const options = makeOptions();
    const page = chapter.pages[0] as MangaPage;
    const renderedBefore = options.resolveFontSizePx(
      page.blocks[0] as TranslationBlock,
      page,
    );
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      rule,
      options,
    );
    expect(preview.results[0]?.afterBlock.fontSizeIntent).toBe("manual");
    expect(preview.results[0]?.afterBlock.fontSizePx).toBe(renderedBefore);
    expect(
      applyConditionalBatchPreview(
        chapter,
        rule,
        preview,
        new Set(),
        undefined,
        options,
      ).appliedCount,
    ).toBe(1);
  });

  it.each([undefined, false, true])(
    "applies preset size with its explicit auto-fit preference (%s)",
    (autoFitText) => {
      const rule = resizeRule(true);
      rule.actions = [
        {
          id: "preset",
          type: "applyStylePreset",
          enabled: true,
          presetName: "크기",
          groupIds: ["size"],
          format: {
            fontSizePx: 25,
            ...(autoFitText === undefined ? {} : { autoFitText }),
          },
        },
      ];
      const chapter = makeChapter([makeBlock({ fontSizePx: 25 })]);
      const preview = createConditionalBatchPreview(
        chapter,
        { kind: "chapter" },
        rule,
      );
      expect(preview.results[0]?.afterBlock).toMatchObject({
        fontSizePx: 25,
        autoFitText: autoFitText ?? true,
        fontSizeIntent: "manual",
      });
      expect(
        applyConditionalBatchPreview(chapter, rule, preview, new Set())
          .appliedCount,
      ).toBe(1);
    },
  );

  it.each([
    { fontSizeIntent: "manual" as const },
    { autoFitText: true },
    { sourceFontFacePx: 17 },
  ])("skips a stale size preview after another edit: %j", (patch) => {
    const chapter = makeChapter([makeBlock({ fontSizePx: 25 })]);
    const options = makeOptions();
    const rule = resizeRule();
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      rule,
      options,
    );
    const current = structuredClone(chapter);
    Object.assign(current.pages[0]?.blocks[0] ?? {}, patch);
    const applied = applyConditionalBatchPreview(
      current,
      rule,
      preview,
      new Set(),
      undefined,
      options,
    );
    expect(applied).toMatchObject({ appliedCount: 0, conflictCount: 1 });
    expect(applied.chapter).toEqual(current);
  });

  it("reevaluates rendered sizes at each sequence step and preserves excluded results", () => {
    const first = { id: "first", ...resizeRule(), actions: [sizeAction(18)] };
    const last = { id: "last", ...resizeRule() };
    const sequence = {
      id: "sequence",
      name: "연속",
      description: "",
      steps: [
        { id: "step-1", schemeId: first.id, enabled: true },
        { id: "step-2", schemeId: last.id, enabled: true },
      ],
    };
    const snapshot = {
      schemaVersion: 1 as const,
      schemes: [first, last],
      sequences: [sequence],
    };
    const chapter = makeChapter([
      makeBlock({ id: "one", fontSizePx: 32 }),
      makeBlock({ id: "two", fontSizePx: 25 }),
    ]);
    const options = makeOptions();
    const preview = createConditionalBatchSequencePreview(
      chapter,
      { kind: "chapter" },
      sequence,
      snapshot,
      options,
    );
    expect(preview.preview.results).toHaveLength(2);
    const result = preview.preview.results[0];
    expect(result?.sequenceTrace).toHaveLength(2);
    expect(result?.resolvedFieldValues?.fontSizePx?.after).toBe(25);
    expect(result?.conditionEvaluations[1]?.rawValue).toBe(18);
    const excluded = new Set([preview.preview.results[1]?.key ?? ""]);
    const applied = applyConditionalBatchSequencePreview(
      chapter,
      sequence,
      snapshot,
      preview,
      excluded,
      undefined,
      options,
    );
    expect(applied).toMatchObject({
      appliedCount: 1,
      conflictCount: 0,
      dirtyPageIds: ["page-0"],
    });
    expect(applied.chapter.pages[1]).toEqual(chapter.pages[1]);
    const firstPage = applied.chapter.pages[0] as MangaPage;
    expect(
      options.resolveFontSizePx(
        firstPage.blocks[0] as TranslationBlock,
        firstPage,
      ),
    ).toBe(25);
  });

  it("counts removing an automatic layout direction as a change even when the stored direction is identical", () => {
    const block = makeBlock();
    const chapter = makeChapter([block]);
    const rule = resizeRule(true);
    rule.actions = [
      {
        id: "direction",
        type: "setFields",
        enabled: true,
        changes: [
          {
            field: "renderDirection",
            operation: "set",
            value: block.renderDirection,
          },
        ],
      },
    ];
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      rule,
    );
    expect(preview.results[0]?.changedFields).toContain("renderDirection");
    const applied = applyConditionalBatchPreview(
      chapter,
      rule,
      preview,
      new Set(),
    );
    expect(applied.appliedCount).toBe(1);
    expect(applied.chapter.pages[0]?.blocks[0]).toMatchObject({
      layoutIntentSuppressed: true,
      fontSizeIntent: "source-match",
    });
  });
});

function makeOptions() {
  return {
    resolveFontSizePx: createConditionalBatchFontSizeResolver(
      DEFAULT_BLOCK_FONT_CATALOG,
    ),
  };
}

function sizeAction(value: number): ConditionalBatchActionV2 {
  return {
    id: "size",
    enabled: true,
    type: "setFields",
    changes: [{ field: "fontSizePx", operation: "set", value }],
  };
}

function resizeRule(allBlocks = false): ConditionalBatchSchemeDraftV2 {
  return ConditionalBatchSchemeDraftV2Schema.parse({
    name: "글자키우기",
    description: "",
    match: {
      mode: allBlocks ? "allBlocks" : "any",
      groups: [],
      conditions: allBlocks
        ? []
        : [
            {
              id: "small",
              enabled: true,
              field: "fontSizePx",
              operator: "lessThan",
              value: 25,
            },
          ],
    },
    actions: [sizeAction(25)],
  });
}

function makeBlock(patch: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id: "block",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 600, h: 600 },
    sourceText: "あ",
    translatedText: "대사",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 32,
    fontSizeIntent: "source-match",
    autoFitText: false,
    sourceFontFacePx: 11,
    sourceFontSizeConfidence: 0.9,
    sourceFontSizeMethod: "raster-core-v1",
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    ...patch,
  };
}

function makeChapter(blocks: TranslationBlock[]): ChapterSnapshot {
  const pages: MangaPage[] = blocks.map((block, index) => ({
    id: `page-${index}`,
    name: `${String(index + 8).padStart(3, "0")}.jpg`,
    imagePath: "",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [block],
    analysisStatus: "completed",
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
  }));
  return {
    id: "chapter",
    workId: "work",
    title: "4화",
    sourceKind: "images",
    status: "completed",
    pages,
    pageOrder: pages.map((page) => page.id),
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
  };
}
