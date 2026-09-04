/* eslint-disable max-lines -- schema, engine, storage, and extended text-appearance regressions share one conditional-rule fixture */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { ConditionalBatchSchemeStore } from "../src/main/conditionalBatchSchemeStore";
import {
  ConditionalBatchSchemeDraftV2Schema,
  ConditionalBatchSnapshotV2Schema,
  createBlankBatchSchemeDraft,
  createConditionalBatchRecipeDraft,
  createEllipsisBatchSchemeDraft,
  type ConditionalBatchConditionV2,
  type ConditionalBatchReplaceTextActionV2,
  type ConditionalBatchSchemeDraftV2,
  type ConditionalBatchSnapshotV2,
} from "../src/shared/conditionalBatchRules";
import {
  applyConditionalBatchPreview,
  applyConditionalBatchSequencePreview,
  createConditionalBatchPreview,
  createConditionalBatchPreviewPage,
  createConditionalBatchSequencePreview,
  evaluateConditionalBatchMatch,
} from "../src/shared/conditionalBatchEngine";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { parseRichText } from "../src/shared/richTextMarkup";
import {
  createConditionalLiteralMatcher,
  createConditionalLiteralReplacement,
  testConditionalTextMatcher,
} from "../src/shared/conditionalTextPattern";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("conditional batch v2 matching and preview", () => {
  it("cleans common ellipses and repeated horizontal whitespace together", () => {
    const preview = createConditionalBatchPreview(
      singleBlockChapter("기다려...   지금 가"),
      { kind: "chapter" },
      createEllipsisBatchSchemeDraft(),
    );

    expect(preview.results[0]?.after.translatedText).toBe("기다려… 지금 가");
  });

  it("keeps stable page/block order and supports selection, page, and chapter scopes", () => {
    const chapter = makeChapter([
      makePage("page-2", [
        makeBlock("block-c", "また...", "셋...넷..."),
        makeBlock("block-b", "なし", "변경 없음"),
      ]),
      makePage("page-1", [makeBlock("block-a", "え...", "하나...둘")]),
    ]);
    chapter.pageOrder = ["page-1", "page-2"];
    requiredItem(chapter.pages, 0).blockOrder = ["block-b", "block-c"];

    const chapterPreview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      createEllipsisBatchSchemeDraft(),
    );
    expect(chapterPreview.results.map((result) => result.blockId)).toEqual([
      "block-a",
      "block-c",
    ]);
    expect(chapterPreview.results[1]).toMatchObject({
      before: { sourceText: "また...", translatedText: "셋...넷..." },
      after: { sourceText: "また...", translatedText: "셋…넷…" },
      changedFields: ["translatedText"],
    });

    const pagePreview = createConditionalBatchPreview(
      chapter,
      { kind: "page", pageId: "page-2" },
      createEllipsisBatchSchemeDraft(),
    );
    expect(pagePreview.results.map((result) => result.blockId)).toEqual([
      "block-c",
    ]);

    const selectionPreview = createConditionalBatchPreview(
      chapter,
      {
        kind: "selection",
        pageId: "page-2",
        blockIds: ["block-b"],
      },
      makeReplacementScheme({ find: "변경", replace: "선택" }),
    );
    expect(selectionPreview.results.map((result) => result.blockId)).toEqual([
      "block-b",
    ]);
  });

  it("supports all/any, disabled conditions, a nested group, and explicit all-blocks", () => {
    const block = {
      ...makeBlock("block", " 원문 ", ""),
      confidence: 0.45,
      renderDirection: "vertical" as const,
    };
    const source = condition("sourceText", "contains", "원");
    const empty = condition("translatedText", "empty");
    const lowConfidence = condition("confidence", "lessThan", 0.5);
    const disabledFailure = {
      ...condition("sourceText", "equals", "불일치"),
      enabled: false,
    };

    expect(
      evaluateConditionalBatchMatch(block, {
        mode: "all",
        conditions: [source, disabledFailure],
        groups: [
          {
            id: "group",
            enabled: true,
            logic: "any",
            conditions: [empty, lowConfidence],
          },
        ],
      }).matched,
    ).toBe(true);
    expect(
      evaluateConditionalBatchMatch(block, {
        mode: "any",
        conditions: [condition("sourceText", "equals", "아님"), source],
        groups: [],
      }).matched,
    ).toBe(true);
    expect(
      evaluateConditionalBatchMatch(block, {
        mode: "allBlocks",
        conditions: [],
        groups: [],
      }).matched,
    ).toBe(true);
    expect(
      evaluateConditionalBatchMatch(block, {
        mode: "all",
        conditions: [source],
        groups: [
          {
            id: "all-group",
            enabled: true,
            logic: "all",
            conditions: [empty, lowConfidence],
          },
        ],
      }).matched,
    ).toBe(true);
  });

  it.each([
    ["startsWith", "원문", "원", true],
    ["endsWith", "원문", "문", true],
    ["notContains", "원문", "없음", true],
    ["regex", "ABC-12", "^[A-Z]+-\\d+$", true],
    ["notRegex", "ABC-12", "^z", true],
  ] as const)(
    "evaluates text operator %s",
    (operator, actual, expected, matched) => {
      const block = makeBlock("block", actual, "번역");
      expect(
        evaluateConditionalBatchMatch(block, {
          mode: "all",
          conditions: [condition("sourceText", operator, expected)],
          groups: [],
        }).matched,
      ).toBe(matched);
    },
  );

  it("evaluates enum, number, color, boolean, derived, and inspection fields", () => {
    const block: TranslationBlock = {
      ...makeBlock("block", "가격 100", "가격 200  "),
      confidence: 0.61,
      renderDirection: "vertical",
      textColor: "#112233",
      bold: true,
      underline: true,
      strikethrough: true,
      emphasisMark: true,
      textBackgroundEnabled: true,
      textBackgroundColor: "#fefefe",
      outerOutlineColor: "#220011",
      outerOutlineWidthPx: 3,
      textGlow: {
        enabled: true,
        color: "#ff8800",
        blurPx: 8,
        opacity: 0.65,
      },
      reviewStatus: "needs_review",
      bbox: { x: 0, y: 0, w: 500, h: 250 },
    };
    const match = {
      mode: "all" as const,
      conditions: [
        condition("renderDirection", "oneOf", ["vertical"]),
        condition("confidence", "between", 0.6, { value2: 0.7 }),
        condition("textColor", "near", "#102234", { tolerance: 2 }),
        condition("bold", "isTrue"),
        condition("underline", "isTrue"),
        condition("strikethrough", "isTrue"),
        condition("emphasisMark", "isTrue"),
        condition("textBackgroundEnabled", "isTrue"),
        condition("textBackgroundColor", "equals", "#fefefe"),
        condition("outerOutlineColor", "equals", "#220011"),
        condition("outerOutlineWidthPx", "greaterThanOrEqual", 3),
        condition("textGlowEnabled", "isTrue"),
        condition("textGlowColor", "equals", "#ff8800"),
        condition("textGlowBlur", "equals", 8),
        condition("textGlowOpacity", "equals", 0.65),
        condition("bboxAspectRatio", "equals", 2),
        condition("numberMismatch", "isTrue"),
        condition("suspiciousWhitespace", "isTrue"),
      ],
      groups: [],
    };
    expect(
      evaluateConditionalBatchMatch(block, match, {
        page: makePage("page", [block]),
        pageIndex: 0,
        blockIndex: 0,
      }).matched,
    ).toBe(true);
  });

  it("treats omitted boolean formatting as the value rendered by the editor", () => {
    const block = makeBlock("block", "원문", "번역");

    expect(
      evaluateConditionalBatchMatch(block, {
        mode: "all",
        conditions: [condition("bold", "isFalse")],
        groups: [],
      }).matched,
    ).toBe(true);
    expect(
      evaluateConditionalBatchMatch(block, {
        mode: "all",
        conditions: [condition("autoFitText", "isTrue")],
        groups: [],
      }).matched,
    ).toBe(true);
  });

  it("does not create false boolean overrides for formatting that is already off", () => {
    const chapter = makeChapter([
      makePage("page", [
        makeBlock("unset", "원문", "미지정"),
        { ...makeBlock("off", "원문", "꺼짐"), bold: false },
        { ...makeBlock("on", "원문", "켜짐"), bold: true },
      ]),
    ]);
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      {
        name: "굵게 끄기",
        description: "",
        match: allBlocksMatch(),
        actions: [
          {
            id: "bold-off",
            enabled: true,
            type: "setFields",
            changes: [{ field: "bold", operation: "set", value: false }],
          },
        ],
      },
    );

    expect(preview.matchedCount).toBe(3);
    expect(preview.matchedResultKeys).toHaveLength(3);
    expect(preview.results.map((result) => result.blockId)).toEqual(["on"]);
    expect(preview.unchangedMatchCount).toBe(2);
    expect(preview.results[0]?.beforeBlock.bold).toBe(true);
    expect(preview.results[0]?.afterBlock.bold).toBe(false);
  });

  it("returns inspection results without mutating data", () => {
    const chapter = makeChapter([
      makePage("page", [
        makeBlock("empty", "source", ""),
        makeBlock("filled", "source", "번역"),
      ]),
    ]);
    const scheme = createConditionalBatchRecipeDraft("emptyTranslation");
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      scheme,
    );
    expect(preview.inspectionOnly).toBe(true);
    expect(preview.results.map((result) => result.blockId)).toEqual(["empty"]);
    expect(preview.results[0]?.changedFields).toEqual([]);
    expect(
      applyConditionalBatchPreview(chapter, scheme, preview, new Set()).chapter,
    ).toBe(chapter);
  });
});

describe("conditional batch v2 actions", () => {
  it("keeps replacement tokens literal in literal mode and supports first-only", () => {
    const chapter = singleBlockChapter("A+B and a+b");
    const all = makeReplacementScheme({
      caseSensitive: false,
      find: "A+B",
      replace: "$& $1",
    });
    expect(previewText(chapter, all)).toBe("$& $1 and $& $1");
    const firstAction = asReplaceAction(requiredItem(all.actions, 0));
    const first = makeReplacementScheme({
      ...firstAction,
      allOccurrences: false,
    });
    expect(previewText(chapter, first)).toBe("$& $1 and a+b");
  });

  it("supports regex captures and both source/translated targets", () => {
    const chapter = makeChapter([
      makePage("page-1", [makeBlock("block", "Hello world", "hello world")]),
    ]);
    const scheme = makeReplacementScheme({
      target: "both",
      searchMode: "regex",
      caseSensitive: false,
      find: "(hello)\\s+(world)",
      replace: "$2, $1",
    });
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      scheme,
    );
    expect(preview.results[0]).toMatchObject({
      changedFields: ["sourceText", "translatedText"],
      after: {
        sourceText: "world, Hello",
        translatedText: "world, hello",
      },
    });
  });

  it("preserves unchanged inline formatting and lets inserted text inherit the first match style", () => {
    const chapter = singleBlockChapter("앞 **찾기** [opacity=50]뒤[/opacity]");
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      makeReplacementScheme({ find: "찾기", replace: "교체" }),
    );
    expect(preview.results[0]?.afterBlock.translatedText).toBe(
      "앞 **교체** [opacity=50]뒤[/opacity]",
    );
  });

  it("uses fixed action stages and traces each intermediate action", () => {
    const chapter = singleBlockChapter("기존");
    const scheme: ConditionalBatchSchemeDraftV2 = {
      name: "파이프라인",
      description: "",
      match: allBlocksMatch(),
      actions: [
        {
          id: "style",
          enabled: true,
          type: "styleText",
          target: "translatedText",
          scope: "pattern",
          matcher: createConditionalLiteralMatcher("완료"),
          allOccurrences: true,
          styleMode: "overwrite",
          patch: { bold: true },
        },
        {
          id: "replace",
          enabled: true,
          type: "replaceText",
          target: "translatedText",
          matcher: createConditionalLiteralMatcher("준비"),
          replacement: createConditionalLiteralReplacement("완료"),
          allOccurrences: true,
        },
        {
          id: "set",
          enabled: true,
          type: "setFields",
          changes: [
            { field: "translatedText", operation: "set", value: "준비" },
            { field: "reviewStatus", operation: "set", value: "reviewed" },
          ],
        },
      ],
    };
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      scheme,
    );
    expect(preview.results[0]?.afterBlock).toMatchObject({
      translatedText: "**완료**",
      reviewStatus: "reviewed",
    });
    expect(
      preview.results[0]?.actionTrace.map((trace) => trace.actionId),
    ).toEqual(["set", "replace", "style"]);
  });

  it("applies a saved preset snapshot instead of resolving the live preset", () => {
    const chapter = singleBlockChapter("텍스트");
    const scheme: ConditionalBatchSchemeDraftV2 = {
      name: "프리셋",
      description: "",
      match: allBlocksMatch(),
      actions: [
        {
          id: "preset",
          enabled: true,
          type: "applyStylePreset",
          presetId: "deleted-later",
          presetName: "세로 효과음",
          groupIds: ["direction", "size", "emphasis"],
          format: {
            renderDirection: "vertical",
            fontSizePx: 42,
            bold: true,
          },
        },
      ],
    };
    const result = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      scheme,
    ).results[0];
    expect(result?.afterBlock).toMatchObject({
      renderDirection: "vertical",
      fontSizePx: 42,
      bold: true,
      layoutIntentSuppressed: true,
    });
  });

  it("previews text-effect preset and property changes as real formatting changes", () => {
    const chapter = singleBlockChapter("텍스트");
    const preset: ConditionalBatchSchemeDraftV2 = {
      name: "텍스트 효과",
      description: "",
      match: allBlocksMatch(),
      actions: [
        {
          id: "effect-preset",
          enabled: true,
          type: "applyStylePreset",
          presetName: "그림자",
          groupIds: ["effect"],
          format: {
            textEffect: {
              enabled: true,
              color: "#123456",
              offsetXpx: 3,
              offsetYpx: 4,
              blurPx: 5,
              opacity: 0.6,
            },
          },
        },
      ],
    };
    const presetResult = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      preset,
    ).results[0];
    expect(presetResult?.afterBlock.textEffect).toMatchObject({
      enabled: true,
      color: "#123456",
      blurPx: 5,
    });
    expect(presetResult?.changedFields).toContain("textEffectColor");

    const property: ConditionalBatchSchemeDraftV2 = {
      name: "효과 색",
      description: "",
      match: allBlocksMatch(),
      actions: [
        {
          id: "effect-field",
          enabled: true,
          type: "setFields",
          changes: [
            { field: "textEffectColor", operation: "set", value: "#abcdef" },
          ],
        },
      ],
    };
    expect(
      createConditionalBatchPreview(chapter, { kind: "chapter" }, property)
        .results[0]?.afterBlock.textEffect?.color,
    ).toBe("#abcdef");
  });

  it("sets and clears the complete block text appearance through field actions", () => {
    const chapter = singleBlockChapter("텍스트");
    const appearance: ConditionalBatchSchemeDraftV2 = {
      name: "전체 글자 모양",
      description: "",
      match: allBlocksMatch(),
      actions: [
        {
          id: "appearance",
          enabled: true,
          type: "setFields",
          changes: [
            { field: "underline", operation: "set", value: true },
            { field: "strikethrough", operation: "set", value: true },
            { field: "emphasisMark", operation: "set", value: true },
            { field: "textBackgroundEnabled", operation: "set", value: true },
            {
              field: "textBackgroundColor",
              operation: "set",
              value: "#fefefe",
            },
            {
              field: "outerOutlineColor",
              operation: "set",
              value: "#220011",
            },
            { field: "outerOutlineWidthPx", operation: "set", value: 3 },
            { field: "textGlowEnabled", operation: "set", value: true },
            {
              field: "textGlowColor",
              operation: "set",
              value: "#ff8800",
            },
            { field: "textGlowBlur", operation: "set", value: 8 },
            { field: "textGlowOpacity", operation: "set", value: 0.65 },
          ],
        },
      ],
    };
    const after = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      appearance,
    ).results[0]?.afterBlock;
    expect(after).toMatchObject({
      underline: true,
      strikethrough: true,
      emphasisMark: true,
      textBackgroundEnabled: true,
      textBackgroundColor: "#fefefe",
      outerOutlineColor: "#220011",
      outerOutlineWidthPx: 3,
      textGlow: {
        enabled: true,
        color: "#ff8800",
        blurPx: 8,
        opacity: 0.65,
      },
    });

    const cleared: ConditionalBatchSchemeDraftV2 = {
      ...appearance,
      actions: [
        {
          id: "clear-glow",
          enabled: true,
          type: "setFields",
          changes: [{ field: "textGlowEnabled", operation: "clear" }],
        },
      ],
    };
    expect(
      createConditionalBatchPreview(
        {
          ...chapter,
          pages: chapter.pages.map((page) => ({
            ...page,
            blocks: page.blocks.map((block) => ({ ...block, ...after })),
          })),
        },
        { kind: "chapter" },
        cleared,
      ).results[0]?.afterBlock.textGlow,
    ).toBeUndefined();
    expect(
      createConditionalBatchPreview(chapter, { kind: "chapter" }, cleared)
        .results,
    ).toHaveLength(0);
  });

  it("applies, fills, and replaces inline styles only inside matched ranges", () => {
    const chapter = singleBlockChapter("앞 찾기 뒤");
    const overwrite = styleScheme({
      scope: "pattern",
      find: "찾기",
      styleMode: "overwrite",
      patch: { italic: true, opacity: 0.5 },
    });
    expect(previewText(chapter, overwrite)).toBe(
      "앞 [opacity=50]*찾기*[/opacity] 뒤",
    );

    const styled = singleBlockChapter("앞 **찾기** 뒤");
    const fill = styleScheme({
      scope: "pattern",
      find: "찾기",
      styleMode: "fillMissing",
      patch: { bold: false, italic: true },
    });
    expect(previewText(styled, fill)).toBe("앞 ***찾기*** 뒤");

    const replace = styleScheme({
      scope: "pattern",
      find: "찾기",
      styleMode: "replace",
      patch: { italic: true },
    });
    expect(previewText(styled, replace)).toBe("앞 *찾기* 뒤");

    const mixedStyles = singleBlockChapter(
      "평문 **굵게** [size=30]큰글자[/size] [size=30]**둘다**[/size]",
    );
    const allExistingStyles = styleScheme({
      scope: "allText",
      matchStyle: {
        logic: "all",
        conditions: [
          {
            id: "bold-style",
            field: "bold",
            operator: "equals",
            value: true,
          },
          {
            id: "large-style",
            field: "sizePx",
            operator: "greaterThanOrEqual",
            value: 30,
          },
        ],
      },
      patch: { italic: true },
    });
    expect(previewText(mixedStyles, allExistingStyles)).toBe(
      "평문 **굵게** [size=30]큰글자[/size] [size=30]***둘다***[/size]",
    );

    const anyExistingStyle = styleScheme({
      scope: "allText",
      matchStyle: {
        logic: "any",
        conditions: [
          {
            id: "bold-style",
            field: "bold",
            operator: "equals",
            value: true,
          },
          {
            id: "large-style",
            field: "sizePx",
            operator: "greaterThanOrEqual",
            value: 30,
          },
        ],
      },
      patch: { italic: true },
    });
    expect(previewText(mixedStyles, anyExistingStyle)).toBe(
      "평문 ***굵게*** [size=30]*큰글자*[/size] [size=30]***둘다***[/size]",
    );
  });

  it("applies and matches the complete inline visual style set", () => {
    const chapter = singleBlockChapter("앞 효과 뒤");
    const styled = styleScheme({
      scope: "pattern",
      find: "효과",
      styleMode: "overwrite",
      patch: {
        underline: true,
        strikethrough: true,
        emphasisMark: true,
        widthScale: 1.2,
        color: "#112233",
        backgroundColor: "#fefefe",
        outlineColor: "#ffffff",
        outlineWidthPx: 2,
        outerOutlineColor: "#000000",
        outerOutlineWidthPx: 3,
        glowColor: "#ff8800",
        glowBlurPx: 6,
        glowOpacity: 0.65,
      },
    });
    const styledText = previewText(chapter, styled);
    if (styledText === undefined) throw new Error("Expected styled preview");
    const effectRun = parseRichText(styledText).runs.find(
      (run) => run.text === "효과",
    );
    expect(effectRun).toMatchObject({
      underline: true,
      strikethrough: true,
      emphasisMark: true,
      widthScale: 1.2,
      color: "#112233",
      backgroundColor: "#fefefe",
      outlineWidthPx: 2,
      outerOutlineWidthPx: 3,
      glowBlurPx: 6,
      glowOpacity: 0.65,
    });

    const matched = styleScheme({
      scope: "allText",
      matchStyle: {
        logic: "all",
        conditions: [
          {
            id: "background",
            field: "backgroundColor",
            operator: "equals",
            value: "#fefefe",
          },
          {
            id: "outer",
            field: "outerOutlineWidthPx",
            operator: "greaterThanOrEqual",
            value: 3,
          },
        ],
      },
      patch: { italic: true },
    });
    expect(previewText(singleBlockChapter(styledText), matched)).toContain(
      "*효과*",
    );
  });
});

describe("conditional batch apply safety and sequences", () => {
  it("excludes selected results and updates all remaining pages in one result", () => {
    const chapter = makeChapter([
      makePage("page-1", [makeBlock("a", "a", "하나...")]),
      makePage("page-2", [makeBlock("b", "b", "둘...")]),
    ]);
    const scheme = createEllipsisBatchSchemeDraft();
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      scheme,
    );
    const excluded = new Set([requiredItem(preview.results, 1).key]);
    expect(
      createConditionalBatchPreviewPage(
        requiredItem(chapter.pages, 1),
        preview,
        excluded,
        true,
      ),
    ).toBe(requiredItem(chapter.pages, 1));

    const result = applyConditionalBatchPreview(
      chapter,
      scheme,
      preview,
      excluded,
      "2026-08-31T00:00:00.000Z",
    );
    expect(result).toMatchObject({
      appliedCount: 1,
      conflictCount: 0,
      dirtyPageIds: ["page-1"],
    });
    expect(result.chapter.pages[0]?.blocks[0]?.translatedText).toBe("하나…");
    expect(result.chapter.pages[1]?.blocks[0]?.translatedText).toBe("둘...");
  });

  it("rechecks both condition inputs and action targets before applying", () => {
    const chapter = singleBlockChapter("원래...");
    const scheme = createEllipsisBatchSchemeDraft();
    const preview = createConditionalBatchPreview(
      chapter,
      { kind: "chapter" },
      scheme,
    );
    const page = requiredItem(chapter.pages, 0);
    const block = requiredItem(page.blocks, 0);
    const edited = {
      ...chapter,
      pages: [
        {
          ...page,
          blocks: [
            {
              ...block,
              translatedText: "수동 수정...",
            },
          ],
        },
      ],
    };
    const result = applyConditionalBatchPreview(
      edited,
      scheme,
      preview,
      new Set(),
    );
    expect(result.appliedCount).toBe(0);
    expect(result.conflictCount).toBe(1);
    expect(result.chapter).toBe(edited);
  });

  it("reevaluates every sequence step against the previous intermediate result", () => {
    const chapter = singleBlockChapter("a");
    const first = {
      id: "first",
      ...makeReplacementScheme({ find: "a", replace: "b" }),
    };
    const second = {
      id: "second",
      ...makeReplacementScheme({ find: "b", replace: "c" }),
    };
    const snapshot: ConditionalBatchSnapshotV2 = {
      schemaVersion: 1,
      schemes: [first, second],
      sequences: [],
    };
    const sequence = {
      id: "sequence",
      name: "a → c",
      description: "",
      steps: [
        { id: "step-1", schemeId: "first", enabled: true },
        { id: "step-2", schemeId: "second", enabled: true },
      ],
    };
    const result = createConditionalBatchSequencePreview(
      chapter,
      { kind: "chapter" },
      sequence,
      snapshot,
    );
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]?.preview.results).toHaveLength(1);
    expect(result.chapterAfter.pages[0]?.blocks[0]?.translatedText).toBe("c");
    expect(result.preview.results[0]?.afterBlock.translatedText).toBe("c");
    expect(result.preview.results[0]?.sequenceTrace).toHaveLength(2);

    const applied = applyConditionalBatchSequencePreview(
      chapter,
      sequence,
      snapshot,
      result,
      new Set(),
      "2026-08-31T00:00:00.000Z",
    );
    expect(applied).toMatchObject({
      appliedCount: 1,
      conflictCount: 0,
      dirtyPageIds: ["page"],
    });
    expect(applied.chapter.pages[0]?.blocks[0]?.translatedText).toBe("c");

    const manuallyEdited = singleBlockChapter("수동 수정");
    const conflicted = applyConditionalBatchSequencePreview(
      manuallyEdited,
      sequence,
      snapshot,
      result,
      new Set(),
    );
    expect(conflicted).toMatchObject({ appliedCount: 0, conflictCount: 1 });
    expect(conflicted.chapter).toBe(manuallyEdited);
  });
});

describe("conditional batch v2 schema and storage", () => {
  it("rejects implicit-all, invalid regex, duplicate ids, depth overflow shapes, and bad field values", () => {
    const valid = createEllipsisBatchSchemeDraft();
    expect(
      ConditionalBatchSchemeDraftV2Schema.safeParse({
        ...valid,
        match: { mode: "all", conditions: [], groups: [] },
      }).success,
    ).toBe(false);
    expect(
      ConditionalBatchSchemeDraftV2Schema.safeParse({
        ...valid,
        match: {
          mode: "allBlocks",
          conditions: [
            {
              id: "condition-invalid-in-all-blocks",
              enabled: true,
              field: "translatedText",
              operator: "contains",
              value: "찾기",
            },
          ],
          groups: [],
        },
      }).success,
    ).toBe(false);
    expect(
      ConditionalBatchSchemeDraftV2Schema.safeParse({
        ...valid,
        actions: [
          {
            ...asReplaceAction(requiredItem(valid.actions, 0)),
            matcher: {
              mode: "regex",
              source: "[",
              caseSensitive: true,
            },
          },
        ],
      }).success,
    ).toBe(false);
    const action = asReplaceAction(requiredItem(valid.actions, 0));
    expect(
      ConditionalBatchSchemeDraftV2Schema.safeParse({
        ...valid,
        actions: [action, { ...action }],
      }).success,
    ).toBe(false);
    expect(
      ConditionalBatchSchemeDraftV2Schema.safeParse({
        ...valid,
        actions: [
          {
            id: "bad-opacity",
            enabled: true,
            type: "setFields",
            changes: [{ field: "textOpacity", operation: "set", value: 3 }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ConditionalBatchSchemeDraftV2Schema.safeParse({
        ...valid,
        match: {
          mode: "all",
          conditions: [condition("underline", "contains", true)],
          groups: [],
        },
      }).success,
    ).toBe(false);
    for (const change of [
      { field: "underline", operation: "set", value: "yes" },
      { field: "outerOutlineWidthPx", operation: "set", value: 100 },
      { field: "textEffectOffsetX", operation: "set", value: 65 },
      { field: "textEffectBlur", operation: "set", value: 65 },
      { field: "textGlowBlur", operation: "set", value: 65 },
      { field: "textBackgroundColor", operation: "set", value: "white" },
      { field: "renderDirection", operation: "set", value: "diagonal" },
    ] as const) {
      expect(
        ConditionalBatchSchemeDraftV2Schema.safeParse({
          ...valid,
          actions: [
            {
              id: `invalid-${change.field}`,
              enabled: true,
              type: "setFields",
              changes: [change],
            },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      ConditionalBatchSchemeDraftV2Schema.safeParse({
        ...valid,
        actions: [
          {
            id: "invalid-effect-preset",
            enabled: true,
            type: "applyStylePreset",
            presetName: "잘못된 광선",
            groupIds: ["effect"],
            format: {
              textGlow: {
                enabled: true,
                color: "#ffffff",
                blurPx: 65,
                opacity: 1,
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("saves v1 YAML atomically, round-trips, updates, and deletes", async () => {
    const root = await makeTemporaryRoot();
    const store = new ConditionalBatchSchemeStore(root);
    const saved = await store.save({
      scheme: createEllipsisBatchSchemeDraft(),
    });
    const id = requiredItem(saved.schemes, 0).id;
    const raw = await readFile(store.filePath, "utf8");
    expect(raw).toContain("schemaVersion: 1");
    expect(
      ConditionalBatchSnapshotV2Schema.parse(parse(raw)).schemes[0]?.name,
    ).toBe("말줄임표·공백 정리");

    await store.save({
      id,
      scheme: { ...createEllipsisBatchSchemeDraft(), name: "수정됨" },
    });
    expect(
      (await new ConditionalBatchSchemeStore(root).list()).schemes[0]?.name,
    ).toBe("수정됨");
    expect(
      (await store.delete(id)).schemes.map((scheme) => scheme.name),
    ).toEqual(["찾아 바꾸기", "말줄임표·공백 정리"]);
  });

  it("imports ID conflicts as copies by default and overwrites only explicitly", async () => {
    const root = await makeTemporaryRoot();
    const store = new ConditionalBatchSchemeStore(root);
    const saved = await store.save({
      scheme: createEllipsisBatchSchemeDraft(),
    });
    const id = requiredItem(saved.schemes, 0).id;
    const yaml = await store.exportYaml([id]);
    const duplicated = await store.importYaml(yaml, "duplicate");
    expect(duplicated.schemes).toHaveLength(4);
    expect(
      duplicated.schemes.some((scheme) => scheme.name.includes("가져옴")),
    ).toBe(true);
    expect(new Set(duplicated.schemes.map((scheme) => scheme.id)).size).toBe(4);

    const modified = parse(yaml);
    modified.schemes[0].name = "덮어쓴 이름";
    const overwritten = await store.importYaml(
      stringify(modified),
      "overwrite",
    );
    expect(overwritten.schemes.find((scheme) => scheme.id === id)?.name).toBe(
      "덮어쓴 이름",
    );
    expect(overwritten.schemes).toHaveLength(4);
  });

  it("saves, updates, and deletes a stored sequence", async () => {
    const root = await makeTemporaryRoot();
    const store = new ConditionalBatchSchemeStore(root);
    const saved = await store.save({
      scheme: createEllipsisBatchSchemeDraft(),
    });
    const schemeId = requiredItem(saved.schemes, 0).id;
    const sequence = {
      id: "sequence-storage-test",
      name: "저장 순서",
      description: "",
      steps: [{ id: "sequence-step-test", schemeId, enabled: true }],
    };

    expect((await store.saveSequence(sequence)).sequences).toEqual([sequence]);
    expect(
      (await store.saveSequence({ ...sequence, name: "수정한 순서" }))
        .sequences[0]?.name,
    ).toBe("수정한 순서");
    expect((await store.deleteSequence(sequence.id)).sequences).toEqual([]);
    await expect(store.deleteSequence(sequence.id)).rejects.toThrow(
      "저장된 연속 실행을 찾을 수 없습니다.",
    );
  });

  it("serializes concurrent saves and never replaces corrupt or future YAML", async () => {
    const root = await makeTemporaryRoot();
    const store = new ConditionalBatchSchemeStore(root);
    await Promise.all(
      ["하나", "둘", "셋"].map((name) =>
        store.save({
          scheme: { ...createEllipsisBatchSchemeDraft(), name },
        }),
      ),
    );
    expect(
      (await store.list()).schemes.map((scheme) => scheme.name).sort(),
    ).toEqual(["둘", "말줄임표·공백 정리", "셋", "찾아 바꾸기", "하나"]);

    const corruptRoot = await makeTemporaryRoot();
    const corruptPath = join(corruptRoot, "batch-edit-schemes.yaml");
    await writeFile(corruptPath, "schemaVersion: [broken", "utf8");
    const corruptStore = new ConditionalBatchSchemeStore(corruptRoot);
    await expect(
      corruptStore.save({ scheme: createEllipsisBatchSchemeDraft() }),
    ).rejects.toThrow("YAML");
    expect(await readFile(corruptPath, "utf8")).toBe("schemaVersion: [broken");

    const futureRoot = await makeTemporaryRoot();
    const futurePath = join(futureRoot, "batch-edit-schemes.yaml");
    await writeFile(
      futurePath,
      stringify({ schemaVersion: 99, schemes: [], sequences: [] }),
      "utf8",
    );
    await expect(
      new ConditionalBatchSchemeStore(futureRoot).list(),
    ).rejects.toThrow();
    expect(parse(await readFile(futurePath, "utf8")).schemaVersion).toBe(99);
  });

  it("creates empty starter drafts without inserting fake search text", () => {
    const blank = createBlankBatchSchemeDraft();
    expect(blank.match).toEqual({
      mode: "allBlocks",
      conditions: [],
      groups: [],
    });
    expect(blank.actions[0]?.id).toMatch(/^action-/);
    expect(ConditionalBatchSchemeDraftV2Schema.safeParse(blank).success).toBe(
      true,
    );
    expect(
      ConditionalBatchSchemeDraftV2Schema.safeParse(
        createConditionalBatchRecipeDraft("findReplace"),
      ).success,
    ).toBe(true);
    const emptyMatcher = (
      createConditionalBatchRecipeDraft("findReplace").actions[0] as
        | ConditionalBatchReplaceTextActionV2
        | undefined
    )?.matcher;
    expect(emptyMatcher).toBeDefined();
    if (!emptyMatcher) throw new Error("Expected an empty visual matcher");
    expect(testConditionalTextMatcher("어떤 번역문", emptyMatcher)).toBe(false);
    expect(
      ConditionalBatchSchemeDraftV2Schema.safeParse(
        createConditionalBatchRecipeDraft("findReplace", { find: "찾기" }),
      ).success,
    ).toBe(true);
    for (const recipe of [
      "ellipsis",
      "whitespace",
      "emptyTranslation",
      "lowConfidence",
      "sameAsSource",
      "numberMismatch",
      "unbalancedPunctuation",
      "suspiciousWhitespace",
      "glossaryMismatch",
      "lengthExceeded",
      "lowFontConfidence",
      "needsReview",
    ] as const) {
      expect(
        ConditionalBatchSchemeDraftV2Schema.safeParse(
          createConditionalBatchRecipeDraft(recipe),
        ).success,
      ).toBe(true);
    }
  });

  it("does not duplicate text matching in replacement recipe conditions", () => {
    for (const recipe of ["findReplace", "ellipsis", "whitespace"] as const) {
      const draft = createConditionalBatchRecipeDraft(recipe, {
        find: "찾을 말",
      });
      expect(draft.match).toEqual({
        mode: "allBlocks",
        conditions: [],
        groups: [],
      });
      expect(draft.actions[0]?.type).toBe("replaceText");
    }
  });
});

async function makeTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mgt-conditional-batch-"));
  temporaryRoots.push(root);
  return root;
}

function condition(
  field: ConditionalBatchConditionV2["field"],
  operator: ConditionalBatchConditionV2["operator"],
  value?: ConditionalBatchConditionV2["value"],
  extra: Pick<ConditionalBatchConditionV2, "value2" | "tolerance"> = {},
): ConditionalBatchConditionV2 {
  if (operator === "regex" || operator === "notRegex") {
    return {
      id: `condition:${field}:${operator}`,
      enabled: true,
      field,
      operator,
      matcher: {
        mode: "regex",
        source: String(value ?? ""),
        caseSensitive: true,
      },
      ...extra,
    };
  }
  return {
    id: `condition:${field}:${operator}`,
    enabled: true,
    field,
    operator,
    ...(value === undefined ? {} : { value }),
    ...extra,
  };
}

function makeBlock(
  id: string,
  sourceText: string,
  translatedText: string,
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 300, h: 200 },
    sourceText,
    translatedText,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 28,
    lineHeight: 1.3,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function makePage(id: string, blocks: TranslationBlock[]): MangaPage {
  return {
    id,
    name: id + ".png",
    imagePath: id + ".png",
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks,
    blockOrder: blocks.map((block) => block.id),
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChapter(pages: MangaPage[]): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function singleBlockChapter(translatedText: string): ChapterSnapshot {
  return makeChapter([
    makePage("page", [makeBlock("block", "source", translatedText)]),
  ]);
}

function previewText(
  chapter: ChapterSnapshot,
  scheme: ConditionalBatchSchemeDraftV2,
): string | undefined {
  return createConditionalBatchPreview(chapter, { kind: "chapter" }, scheme)
    .results[0]?.afterBlock.translatedText;
}

function allBlocksMatch(): ConditionalBatchSchemeDraftV2["match"] {
  return { mode: "allBlocks", conditions: [], groups: [] };
}

function makeReplacementScheme(
  patch:
    | (Partial<ConditionalBatchReplaceTextActionV2> & {
        find?: string;
        replace?: string;
        searchMode?: "literal" | "regex";
        caseSensitive?: boolean;
      })
    | undefined = {},
): ConditionalBatchSchemeDraftV2 {
  const {
    find = "찾기",
    replace = "바꾸기",
    searchMode = "literal",
    caseSensitive = true,
    ...actionPatch
  } = patch;
  return {
    name: "치환 테스트",
    description: "",
    match: allBlocksMatch(),
    actions: [
      {
        id: "replace-action",
        enabled: true,
        type: "replaceText",
        target: "translatedText",
        matcher:
          searchMode === "regex"
            ? { mode: "regex", source: find, caseSensitive }
            : createConditionalLiteralMatcher(find, caseSensitive),
        replacement:
          searchMode === "regex"
            ? { mode: "raw", source: replace }
            : createConditionalLiteralReplacement(replace),
        allOccurrences: true,
        ...actionPatch,
      },
    ],
  };
}

function styleScheme(
  patch: Partial<
    Extract<
      ConditionalBatchSchemeDraftV2["actions"][number],
      { type: "styleText" }
    >
  > & { find?: string },
): ConditionalBatchSchemeDraftV2 {
  const { find, ...actionPatch } = patch;
  return {
    name: "부분 서식",
    description: "",
    match: allBlocksMatch(),
    actions: [
      {
        id: "style",
        enabled: true,
        type: "styleText",
        target: "translatedText",
        scope: "allText",
        allOccurrences: true,
        styleMode: "overwrite",
        patch: { bold: true },
        ...actionPatch,
        ...(actionPatch.scope === "pattern"
          ? { matcher: createConditionalLiteralMatcher(find ?? "찾기") }
          : {}),
      },
    ],
  };
}

function asReplaceAction(
  action: ConditionalBatchSchemeDraftV2["actions"][number],
): ConditionalBatchReplaceTextActionV2 {
  if (action.type !== "replaceText") throw new Error("replace action expected");
  return action;
}

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing fixture item ${index}`);
  return item;
}
