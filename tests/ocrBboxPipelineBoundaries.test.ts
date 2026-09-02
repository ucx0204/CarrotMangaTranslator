import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pipeline =
  require("../src/main/runtime/simple-page-ocr-bbox-pipeline.cjs") as {
    collectOcrBboxHints: (options: Record<string, unknown>) => Promise<{
      hints: unknown[];
      diagnostics: Array<Record<string, unknown>>;
      noTextDetected: boolean;
      textEvidenceCount: number;
    }>;
    readCompletedOcrBatchOutputPayload: (path: string) => unknown;
  };

const hintsRuntime =
  require("../src/main/runtime/simple-page-ocr-hints.cjs") as {
    normalizeOcrBboxHintPayload: (
      payload: unknown,
      options?: Record<string, unknown>,
    ) => Array<Record<string, unknown>>;
  };

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OCR bbox pipeline boundaries", () => {
  it("normalizes scaled boxes while rejecting ignored and degenerate candidates", () => {
    const hints = hintsRuntime.normalizeOcrBboxHintPayload(
      {
        coordinateSpace: "0-1000",
        items: [
          {
            bbox: [900, 800, 100, 100],
            label: "vertical_textline",
            confidence: "0.8",
            text: "テスト",
          },
          { bbox: [100, 100, 200, 200], label: "image" },
          { bbox: [0, 0, 5, 5], label: "text" },
        ],
      },
      { imageWidth: 200, imageHeight: 100, sourceLanguage: "zh" },
    );

    expect(hints).toEqual([
      {
        id: 1,
        label: "vertical_textline",
        x1: 20,
        y1: 10,
        x2: 180,
        y2: 80,
        score: 0.8,
        ocrText: "テスト",
      },
    ]);
  });

  it("preserves only fully contained Hayai recognition segments", () => {
    const valid = hintsRuntime.normalizeOcrBboxHintPayload(
      {
        coordinateSpace: "pixels",
        width: 1000,
        height: 1200,
        items: [
          {
            id: 7,
            label: "text",
            x1: 400,
            y1: 100,
            x2: 600,
            y2: 800,
            ocrText: "前半後半",
            recognitionSegments: [
              { x1: 500, y1: 100, x2: 560, y2: 300, ocrText: "前半" },
              { x1: 420, y1: 320, x2: 600, y2: 800, ocrText: "後半" },
            ],
          },
        ],
      },
      { imageWidth: 1000, imageHeight: 1200, sourceLanguage: "ja" },
    );
    expect(valid[0]?.recognitionSegments).toEqual([
      { x1: 500, y1: 100, x2: 560, y2: 300, ocrText: "前半" },
      { x1: 420, y1: 320, x2: 600, y2: 800, ocrText: "後半" },
    ]);

    const escaped = hintsRuntime.normalizeOcrBboxHintPayload(
      {
        coordinateSpace: "pixels",
        width: 1000,
        height: 1200,
        items: [
          {
            id: 8,
            label: "text",
            x1: 400,
            y1: 100,
            x2: 600,
            y2: 800,
            ocrText: "前半後半",
            recognitionSegments: [
              { x1: 500, y1: 100, x2: 560, y2: 300, ocrText: "前半" },
              { x1: 420, y1: 320, x2: 602.1, y2: 800, ocrText: "後半" },
            ],
          },
        ],
      },
      { imageWidth: 1000, imageHeight: 1200, sourceLanguage: "ja" },
    );
    expect(escaped[0]).not.toHaveProperty("recognitionSegments");
  });

  it("caps normalized candidates at the public 80-hint boundary", () => {
    const items = Array.from({ length: 85 }, (_, index) => ({
      x: index * 4,
      y: 0,
      width: 3,
      height: 12,
      text: `候補${index + 1}`,
    }));

    const hints = hintsRuntime.normalizeOcrBboxHintPayload(items, {
      imageWidth: 400,
      imageHeight: 100,
      sourceLanguage: "zh",
    });

    expect(hints).toHaveLength(80);
    expect(hints.at(-1)?.id).toBe(80);
  });

  it("keeps 80 candidates while removing a review context split by the cap", () => {
    const hints = hintsRuntime.normalizeOcrBboxHintPayload(
      {
        coordinateSpace: "pixels",
        width: 1200,
        height: 1800,
        items: reviewContextBoundaryItems(true),
      },
      { imageWidth: 1200, imageHeight: 1800, sourceLanguage: "ja" },
    );

    expect(hints).toHaveLength(80);
    expect(hints.at(-1)?.id).toBe(80);
    expect(hints.some((hint) => "reviewContextId" in hint)).toBe(false);
  });

  it("does not let the cap hide malformed full review context metadata", () => {
    expect(() =>
      hintsRuntime.normalizeOcrBboxHintPayload(
        {
          coordinateSpace: "pixels",
          width: 1200,
          height: 1800,
          items: reviewContextBoundaryItems(false),
        },
        { imageWidth: 1200, imageHeight: 1800, sourceLanguage: "ja" },
      ),
    ).toThrow("must connect at least two review fragments");
  });

  it("preserves axis-v4 review sidecars and stable sparse ids without regrouping", () => {
    const hints = hintsRuntime.normalizeOcrBboxHintPayload(
      {
        coordinateSpace: "pixels",
        width: 1000,
        height: 1000,
        items: [
          {
            id: 4,
            label: "ocr_textline",
            x1: 600,
            y1: 100,
            x2: 632,
            y2: 250,
            ocrText: "確定本文",
            score: 0.91,
            reviewFragmentId: "B001",
            reviewStatus: "confirmed",
            reviewReasons: [],
            reviewOrder: 1,
            groupId: "G001",
            orderInGroup: 1,
            groupSize: 1,
            rolePrior: "ordinary_mergeable",
            containerType: "same_text_container",
            semanticGroup: true,
            paddleGroupId: "G007",
            paddleOrder: 3,
            paddleGroupSize: 4,
          },
          {
            id: 9,
            label: "ocr_textline",
            x1: 100,
            y1: 500,
            x2: 300,
            y2: 532,
            ocrText: "再検査本文",
            score: 0.88,
            reviewFragmentId: "D001",
            reviewStatus: "deferred",
            reviewReasons: [" ordinary_axis_candidate ", "", 7],
            reviewOrder: 1,
            paddleGroupId: "G009",
            paddleOrder: 2,
            paddleGroupSize: 3,
          },
        ],
      },
      { imageWidth: 1000, imageHeight: 1000, sourceLanguage: "ja" },
    );

    expect(hints).toEqual([
      expect.objectContaining({
        id: 4,
        ocrText: "確定本文",
        reviewFragmentId: "B001",
        reviewStatus: "confirmed",
        reviewReasons: [],
        reviewOrder: 1,
        groupId: "G001",
        orderInGroup: 1,
        groupSize: 1,
        semanticGroup: true,
        paddleGroupId: "G007",
        paddleOrder: 3,
        paddleGroupSize: 4,
      }),
      expect.objectContaining({
        id: 9,
        ocrText: "再検査本文",
        reviewFragmentId: "D001",
        reviewStatus: "deferred",
        reviewReasons: ["ordinary_axis_candidate"],
        reviewOrder: 1,
        paddleGroupId: "G009",
        paddleOrder: 2,
        paddleGroupSize: 3,
      }),
    ]);
    expect(hints[1]).not.toHaveProperty("groupId");
  });

  it("normalizes a connected axis-v4 review context without changing fragments", () => {
    const hints = hintsRuntime.normalizeOcrBboxHintPayload(
      {
        coordinateSpace: "pixels",
        width: 1200,
        height: 1800,
        items: [
          reviewContextItem(1, "B001", 700, 200, 732, 390),
          reviewContextItem(2, "B001", 660, 220, 692, 430, 2),
          reviewContextItem(3, "B002", 620, 252, 652, 462),
        ],
      },
      { imageWidth: 1200, imageHeight: 1800, sourceLanguage: "ja" },
    );

    expect(hints.map((hint) => hint.reviewContextId)).toEqual([
      "RC001",
      "RC001",
      "RC001",
    ]);
    expect(hints.map((hint) => hint.reviewFragmentId)).toEqual([
      "B001",
      "B001",
      "B002",
    ]);
  });

  it.each([
    {
      name: "ignored label",
      filteredCandidate: {
        ...reviewContextItem(3, "B002", 620, 252, 652, 462),
        label: "image",
      },
    },
    {
      name: "invalid geometry",
      filteredCandidate: {
        ...reviewContextItem(3, "B002", 620, 252, 652, 462),
        x2: 621,
      },
    },
  ])(
    "removes a valid review context atomically after filtering: $name",
    ({ filteredCandidate }) => {
      const hints = hintsRuntime.normalizeOcrBboxHintPayload(
        {
          coordinateSpace: "pixels",
          width: 1200,
          height: 1800,
          items: [
            reviewContextItem(1, "B001", 700, 200, 732, 390),
            reviewContextItem(2, "B001", 660, 220, 692, 430, 2),
            filteredCandidate,
          ],
        },
        { imageWidth: 1200, imageHeight: 1800, sourceLanguage: "ja" },
      );

      expect(hints).toHaveLength(2);
      expect(hints.map((hint) => hint.reviewFragmentId)).toEqual([
        "B001",
        "B001",
      ]);
      expect(hints.some((hint) => "reviewContextId" in hint)).toBe(false);
    },
  );

  it("does not let filtering hide malformed source review metadata", () => {
    expect(() =>
      hintsRuntime.normalizeOcrBboxHintPayload(
        {
          coordinateSpace: "pixels",
          width: 1200,
          height: 1800,
          items: [
            reviewContextItem(1, "B001", 700, 200, 732, 390),
            {
              ...reviewContextItem(2, "B002", 620, 252, 652, 462),
              label: "image",
              reviewContextId: "context-one",
            },
          ],
        },
        { imageWidth: 1200, imageHeight: 1800, sourceLanguage: "ja" },
      ),
    ).toThrow("Invalid reviewContextId");
  });

  it("preserves complete anime-text-yolo evidence without changing OCR groups", () => {
    const hints = hintsRuntime.normalizeOcrBboxHintPayload(
      {
        coordinateSpace: "pixels",
        width: 1200,
        height: 1800,
        items: [
          {
            id: 7,
            label: "ocr_textline",
            x1: 1101,
            y1: 1202,
            x2: 1151,
            y2: 1256,
            reviewFragmentId: "D001",
            reviewStatus: "deferred",
            reviewReasons: ["dense_page_single_glyph"],
            reviewOrder: 1,
            animeTextRegionId: "ATY001",
            animeTextRegionScore: 0.8443,
            animeTextContainment: 0.9,
            animeTextRegionBbox: [1015.7, 1199.8, 1145.8, 1427.3],
            animeTextEvidenceVersion: 1,
            animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
          },
        ],
      },
      { imageWidth: 1200, imageHeight: 1800, sourceLanguage: "ja" },
    );

    expect(hints).toEqual([
      expect.objectContaining({
        id: 7,
        reviewFragmentId: "D001",
        reviewStatus: "deferred",
        animeTextRegionId: "ATY001",
        animeTextRegionScore: 0.8443,
        animeTextContainment: 0.9,
        animeTextRegionBbox: [1015.7, 1199.8, 1145.8, 1427.3],
        animeTextEvidenceVersion: 1,
      }),
    ]);
    expect(hints[0]).not.toHaveProperty("groupId");
  });

  it("rejects partial anime-text-yolo evidence instead of silently using it", () => {
    expect(() =>
      hintsRuntime.normalizeOcrBboxHintPayload(
        [
          {
            id: 1,
            x1: 10,
            y1: 10,
            x2: 30,
            y2: 50,
            animeTextRegionId: "ATY001",
          },
        ],
        { imageWidth: 100, imageHeight: 100 },
      ),
    ).toThrow("Incomplete anime-text-yolo evidence");
  });

  it.each([
    {
      name: "invalid id",
      items: [
        {
          ...reviewContextItem(1, "B001", 700, 200, 732, 390),
          reviewContextId: "context-one",
        },
      ],
      message: /Invalid reviewContextId/,
    },
    {
      name: "orphan context",
      items: [reviewContextItem(1, "B001", 700, 200, 732, 390)],
      message: /must connect at least two review fragments/,
    },
    {
      name: "partial fragment context",
      items: [
        reviewContextItem(1, "B001", 700, 200, 732, 390),
        reviewContextItem(2, "B001", 660, 220, 692, 430, 2, false),
        reviewContextItem(3, "B002", 620, 252, 652, 462),
      ],
      message: /inconsistent reviewContextId/,
    },
  ])(
    "rejects malformed review context metadata: $name",
    ({ items, message }) => {
      expect(() =>
        hintsRuntime.normalizeOcrBboxHintPayload(
          {
            coordinateSpace: "pixels",
            width: 1200,
            height: 1800,
            items,
          },
          { imageWidth: 1200, imageHeight: 1800, sourceLanguage: "ja" },
        ),
      ).toThrow(message);
    },
  );

  it("reports a JSON-file read failure without claiming the page has no text", async () => {
    const missingPath = join(tmpdir(), `missing-ocr-${Date.now()}.json`);

    const result = await pipeline.collectOcrBboxHints({
      ocrBboxHintsPath: missingPath,
      ocrBboxProvider: "none",
    });

    expect(result.hints).toEqual([]);
    expect(result.noTextDetected).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        provider: "json-file",
        reason: "ocr-bbox-unavailable",
        path: missingPath,
      }),
    ]);
  });

  it("treats a partial batch JSON as incomplete", () => {
    const directory = mkdtempSync(join(tmpdir(), "ocr-bbox-boundary-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "ocr-bbox-hints.json");
    writeFileSync(outputPath, '{"items": [', "utf8");
    expect(pipeline.readCompletedOcrBatchOutputPayload(outputPath)).toBeNull();
  });
});

function reviewContextItem(
  id: number,
  reviewFragmentId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  reviewOrder = 1,
  includeReviewContext = true,
): Record<string, unknown> {
  return {
    id,
    label: "ocr_textline",
    x1,
    y1,
    x2,
    y2,
    ocrText: `本文${id}`,
    score: 0.95,
    reviewFragmentId,
    reviewStatus: "confirmed",
    reviewReasons: [],
    reviewOrder,
    groupId: reviewFragmentId.replace(/^B/, "G"),
    orderInGroup: reviewOrder,
    groupSize: reviewFragmentId === "B001" ? 2 : 1,
    semanticGroup: true,
    rolePrior: "ordinary_mergeable",
    containerType: "same_text_container",
    ...(includeReviewContext ? { reviewContextId: "rc001" } : {}),
  };
}

function reviewContextBoundaryItems(
  completeBoundaryContext: boolean,
): Array<Record<string, unknown>> {
  return Array.from({ length: 81 }, (_, index) => {
    const id = index + 1;
    const column = index % 20;
    const row = Math.floor(index / 20);
    const includeReviewContext =
      id === 80 || (completeBoundaryContext && id === 81);
    return reviewContextItem(
      id,
      `B${String(id + 99).padStart(3, "0")}`,
      20 + column * 40,
      20 + row * 80,
      44 + column * 40,
      70 + row * 80,
      1,
      includeReviewContext,
    );
  });
}
