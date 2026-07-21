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
