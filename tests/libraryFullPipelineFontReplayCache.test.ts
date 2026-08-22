import path from "node:path";
import { describe, expect, it, vi } from "vitest";

type FontReplayCacheModule = {
  createFontReplayPageDecisionContext: (options: {
    automaticFontCoordinator: {
      createAutomaticFontPageCoordinatorV2: (options: unknown) => unknown;
      orderAutomaticFontMatchingPageItemIndexes: (
        items: unknown[],
        pixelInferences: Array<unknown | undefined>,
      ) => number[];
    };
    chapterCoordinator: unknown;
    inferred: { pixelInferenceByBlockId: Map<string, unknown> };
    modelDirectSelection?: boolean;
    requestBlocks: Array<{ blockId: string; item: unknown }>;
  }) => {
    orderedItemIndexes: number[];
    pageCoordinator: {
      prepareWorkState: (...args: unknown[]) => unknown;
      recordDecision: (...args: unknown[]) => unknown;
    };
    pixelInferences: Array<unknown | undefined>;
  };
  resolveFontReplayImagePath: (
    record: { page: { imagePath: string } },
    cached: { cleanedImagePath?: string | null },
    fontInput: { page: { blocks: unknown[] }; requestBlocks: unknown[] },
  ) => string;
  resolveFontReplayInputPath: (
    cacheFrom: string,
    record: { selectionIndex: number },
    cached: { selectionIndex: number; fontInputPath?: string | null },
  ) => string;
  restoreFontReplaySemanticRole: <T extends Record<string, unknown>>(
    block: T,
    item: unknown,
  ) => T;
};

const {
  createFontReplayPageDecisionContext,
  resolveFontReplayImagePath,
  resolveFontReplayInputPath,
  restoreFontReplaySemanticRole,
} =
  require("../scripts/library-full-pipeline-qa/font-replay-cache.cjs") as FontReplayCacheModule;

const record = { page: { imagePath: "C:\\library\\source.png" } };

describe("font replay cached image resolution", () => {
  it("uses the frozen source image when both cached block lists are empty", () => {
    expect(
      resolveFontReplayImagePath(
        record,
        {},
        {
          page: { blocks: [] },
          requestBlocks: [],
        },
      ),
    ).toBe(record.page.imagePath);
  });

  it("uses the cleaned image when a reusable inpainting asset exists", () => {
    expect(
      resolveFontReplayImagePath(
        record,
        { cleanedImagePath: "C:\\cache\\cleaned.png" },
        { page: { blocks: [{}] }, requestBlocks: [{}] },
      ),
    ).toBe("C:\\cache\\cleaned.png");
  });

  it.each([
    { page: { blocks: [{}] }, requestBlocks: [] },
    { page: { blocks: [] }, requestBlocks: [{}] },
    { page: { blocks: [{}] }, requestBlocks: [{}] },
  ])(
    "fails closed without a cleaned image for non-empty blocks",
    (fontInput) => {
      expect(() => resolveFontReplayImagePath(record, {}, fontInput)).toThrow(
        "Cached run has no reusable translation/inpainting assets.",
      );
    },
  );
});

describe("font replay cached input resolution", () => {
  it("falls back to the deterministic page path for a missing report path", () => {
    expect(
      resolveFontReplayInputPath(
        "C:\\cache-run",
        { selectionIndex: 35 },
        { selectionIndex: 35 },
      ),
    ).toBe(path.join("C:\\cache-run", "pages", "36", "font-input.json"));
  });

  it("keeps an explicit report path", () => {
    expect(
      resolveFontReplayInputPath(
        "C:\\cache-run",
        { selectionIndex: 35 },
        { selectionIndex: 35, fontInputPath: "C:\\sealed\\font-input.json" },
      ),
    ).toBe("C:\\sealed\\font-input.json");
  });

  it("fails closed when the cached selection index drifts", () => {
    expect(() =>
      resolveFontReplayInputPath(
        "C:\\cache-run",
        { selectionIndex: 35 },
        { selectionIndex: 34 },
      ),
    ).toThrow("Cached run page selection index does not match the cohort.");
  });
});

describe("font replay page decision context", () => {
  it("preserves the legacy replay path when pixel inference is unavailable", () => {
    const chapterCoordinator = { kind: "chapter" };
    const pageCoordinator = { kind: "page" };
    const createPageCoordinator = vi.fn(() => pageCoordinator);
    const orderItems = vi.fn(() => [0, 1]);
    const requestBlocks = [
      { blockId: "block-a", item: { sourceText: "A" } },
      { blockId: "block-b", item: { sourceText: "B" } },
    ];

    const context = createFontReplayPageDecisionContext({
      automaticFontCoordinator: {
        createAutomaticFontPageCoordinatorV2: createPageCoordinator,
        orderAutomaticFontMatchingPageItemIndexes: orderItems,
      },
      chapterCoordinator,
      inferred: { pixelInferenceByBlockId: new Map() },
      requestBlocks,
    });

    expect(context).toEqual({
      orderedItemIndexes: [0, 1],
      pageCoordinator,
      pixelInferences: [undefined, undefined],
    });
    expect(createPageCoordinator).toHaveBeenCalledWith({
      chapterCoordinator,
      items: requestBlocks.map((entry) => entry.item),
      pixelInferences: [undefined, undefined],
    });
    expect(orderItems).toHaveBeenCalledWith(
      requestBlocks.map((entry) => entry.item),
      [undefined, undefined],
    );
  });

  it("aligns pixel evidence to request order for page policy and priority", () => {
    const chapterCoordinator = { kind: "chapter" };
    const pageCoordinator = { kind: "page" };
    const pixelA = {
      blockId: "block-a",
      rolePrediction: { primary: "dialogue" },
    };
    const pixelB = {
      blockId: "block-b",
      rolePrediction: { primary: "sfx_motion" },
    };
    const createPageCoordinator = vi.fn(() => pageCoordinator);
    const orderItems = vi.fn(() => [0, 2, 1]);
    const requestBlocks = [
      { blockId: "block-a", item: { sourceText: "A" } },
      { blockId: "block-b", item: { sourceText: "B" } },
      { blockId: "block-c", item: { sourceText: "C" } },
    ];

    const context = createFontReplayPageDecisionContext({
      automaticFontCoordinator: {
        createAutomaticFontPageCoordinatorV2: createPageCoordinator,
        orderAutomaticFontMatchingPageItemIndexes: orderItems,
      },
      chapterCoordinator,
      inferred: {
        // Deliberately reverse Map insertion order to guard against using it.
        pixelInferenceByBlockId: new Map([
          ["block-b", pixelB],
          ["block-a", pixelA],
        ]),
      },
      requestBlocks,
    });

    expect(context).toEqual({
      orderedItemIndexes: [0, 2, 1],
      pageCoordinator,
      pixelInferences: [pixelA, pixelB, undefined],
    });
    expect(createPageCoordinator).toHaveBeenCalledWith({
      chapterCoordinator,
      items: requestBlocks.map((entry) => entry.item),
      pixelInferences: [pixelA, pixelB, undefined],
    });
    expect(orderItems).toHaveBeenCalledWith(
      requestBlocks.map((entry) => entry.item),
      [pixelA, pixelB, undefined],
    );
  });

  it("can isolate the model winner from page and chapter heuristics for visual QA", () => {
    const createPageCoordinator = vi.fn();
    const orderItems = vi.fn();
    const pixelA = { blockId: "block-a" };
    const requestBlocks = [
      { blockId: "block-a", item: { sourceText: "A" } },
      { blockId: "block-b", item: { sourceText: "B" } },
    ];

    const context = createFontReplayPageDecisionContext({
      automaticFontCoordinator: {
        createAutomaticFontPageCoordinatorV2: createPageCoordinator,
        orderAutomaticFontMatchingPageItemIndexes: orderItems,
      },
      chapterCoordinator: { kind: "chapter" },
      inferred: { pixelInferenceByBlockId: new Map([["block-a", pixelA]]) },
      modelDirectSelection: true,
      requestBlocks,
    });

    expect(context.orderedItemIndexes).toEqual([0, 1]);
    expect(context.pixelInferences).toEqual([pixelA, undefined]);
    expect(context.pageCoordinator.prepareWorkState()).toBeUndefined();
    expect(() => context.pageCoordinator.recordDecision()).not.toThrow();
    expect(createPageCoordinator).not.toHaveBeenCalled();
    expect(orderItems).not.toHaveBeenCalled();
  });
});

describe("font replay semantic role restoration", () => {
  it("restores semantic metadata after selection without changing selected styling", () => {
    const applied = {
      id: "block-a",
      fontFamily: "dohyeon",
      fontRole: "dialogue",
      fontRoleConfidence: 0.61,
    };

    const restored = restoreFontReplaySemanticRole(applied, {
      fontRole: "sign_ui_title",
      fontRoleConfidence: 0.97,
    });

    expect(restored).toEqual({
      ...applied,
      fontRole: "sign_ui_title",
      fontRoleConfidence: 0.97,
    });
    expect(restored.fontFamily).toBe(applied.fontFamily);
  });

  it("leaves ordinary replay output untouched without semantic metadata", () => {
    const applied = {
      id: "block-a",
      fontRole: "dialogue",
      fontRoleConfidence: 0.61,
    };

    expect(restoreFontReplaySemanticRole(applied, {})).toBe(applied);
  });

  it("restores concrete layout intent and makes horizontal effective before postprocess", () => {
    const applied = {
      id: "block-a",
      textRole: "ordinary",
      layoutIntent: "vertical",
      renderDirection: "vertical",
    };

    expect(
      restoreFontReplaySemanticRole(applied, {
        textRole: "ordinary",
        layoutIntent: "horizontal",
      }),
    ).toEqual({
      ...applied,
      layoutIntent: "horizontal",
      renderDirection: "horizontal",
    });
    expect(
      restoreFontReplaySemanticRole(
        { ...applied, layoutIntent: undefined, renderDirection: "horizontal" },
        { textRole: "ordinary", layoutIntent: "vertical" },
      ),
    ).toMatchObject({
      layoutIntent: "vertical",
      renderDirection: "horizontal",
    });
  });

  it("clears stale replay intent for auto/sound but honors persisted manual suppression", () => {
    const stale = {
      id: "block-a",
      textRole: "ordinary",
      layoutIntent: "vertical",
      renderDirection: "horizontal",
    };
    const suppressed = {
      id: "block-b",
      textRole: "ordinary",
      layoutIntentSuppressed: true,
      renderDirection: "horizontal",
    };

    expect(
      restoreFontReplaySemanticRole(stale, { textRole: "ordinary" }),
    ).not.toHaveProperty("layoutIntent");
    expect(
      restoreFontReplaySemanticRole(stale, {
        textRole: "sound",
        layoutIntent: "vertical",
      }),
    ).not.toHaveProperty("layoutIntent");
    expect(
      restoreFontReplaySemanticRole(suppressed, {
        textRole: "ordinary",
        layoutIntent: "vertical",
      }),
    ).toBe(suppressed);
  });
});
