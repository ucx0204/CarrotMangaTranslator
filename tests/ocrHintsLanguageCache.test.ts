import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { TranslationOptions } from "../src/main/appSettings";
import { prepareOcrHintsForPages } from "../src/main/pipeline/ocrHints";
import type { TranslationRuntimePort } from "../src/main/pipeline/translationRuntimePort";

const tempDirs: string[] = [];

describe("OCR hint language cache", () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const path = tempDirs.pop();
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  it("reuses cache only for the same source language", async () => {
    const chapterDir = await mkdtemp(join(tmpdir(), "mgt-ocr-lang-cache-"));
    tempDirs.push(chapterDir);
    const page = makePage();
    const collectOcrHintsBatch = vi.fn(async (options: TranslationOptions[]) =>
      options.map((option) => ({
        hints: [
          {
            id: 1,
            label: "text",
            x1: 10,
            y1: 10,
            x2: 80,
            y2: 50,
            ocrText: `ocr-${option.sourceLanguage}`,
          },
        ],
        diagnostics: [],
        noTextDetected: false,
        textEvidenceCount: 1,
      })),
    );
    const runtime = {
      collectOcrHintsBatch,
    } satisfies Pick<TranslationRuntimePort, "collectOcrHintsBatch">;

    const run = (sourceLanguage: string) =>
      prepareOcrHintsForPages({
        runtime,
        baseOptions: { sourceLanguage } as TranslationOptions,
        pages: [page],
        runPaths: { chapterDir, runDir: join(chapterDir, "run") },
        emit: () => undefined,
        jobId: `job-${sourceLanguage}`,
        signal: new AbortController().signal,
      });

    expect(readFirstOcrText(await run("en"), page.id)).toBe("ocr-en");
    expect(readFirstOcrText(await run("en"), page.id)).toBe("ocr-en");
    expect(readFirstOcrText(await run("zh-Hans"), page.id)).toBe("ocr-zh-Hans");
    expect(collectOcrHintsBatch).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached hints whenever the OCR execution configuration changes", async () => {
    const chapterDir = await mkdtemp(join(tmpdir(), "mgt-ocr-config-cache-"));
    tempDirs.push(chapterDir);
    const page = makePage();
    const collectOcrHintsBatch = vi.fn(async () => [
      {
        hints: [],
        diagnostics: [],
        noTextDetected: true,
        textEvidenceCount: 0,
      },
    ]);
    const runtime = {
      collectOcrHintsBatch,
    } satisfies Pick<TranslationRuntimePort, "collectOcrHintsBatch">;
    let options = {
      sourceLanguage: "ja",
      ocrDevice: "cpu",
      ocrGpuBackend: "cuda",
      ocrGpuCudaTag: "cu126",
      ocrQualityMode: "minimum",
      ocrBboxProvider: "paddleocr-vl",
      ocrBboxMode: "ocr",
      ocrEngine: "paddle_static",
      ocrEngineDtype: "float32",
      ocrVersion: "PP-OCRv6",
      ocrTextDetectionModelName: "PP-OCRv6_small_det",
      ocrTextRecognitionModelName: "PP-OCRv6_tiny_rec",
      ocrMergeMode: "conservative",
      ocrDetLimit: "1600",
      ocrRecBatch: "1",
    } as TranslationOptions;
    const run = () =>
      prepareOcrHintsForPages({
        runtime,
        baseOptions: options,
        pages: [page],
        runPaths: { chapterDir, runDir: join(chapterDir, "run") },
        emit: () => undefined,
        jobId: "job-config-cache",
        signal: new AbortController().signal,
      });

    await run();
    await run();
    expect(collectOcrHintsBatch).toHaveBeenCalledTimes(1);

    const changes: Array<Partial<TranslationOptions>> = [
      { ocrDevice: "gpu" },
      { ocrGpuBackend: "rocm-transformers" },
      { ocrGpuCudaTag: "cu129" },
      { ocrQualityMode: "economy" },
      { ocrBboxProvider: "custom-provider" },
      { ocrBboxMode: "vl" },
      { ocrEngine: "transformers" },
      { ocrEngineDtype: "float16" },
      { ocrVersion: "PP-OCRv5" },
      { ocrTextDetectionModelName: "custom-det" },
      { ocrTextRecognitionModelName: "custom-rec" },
      { ocrMergeMode: "legacy" },
      { ocrDetLimit: "960" },
      { ocrRecBatch: "2" },
      { ocrBboxCommand: "custom-ocr-command" },
      { ocrBboxHintsPath: "C:/manga/custom-ocr-hints.json" },
    ];
    for (const [index, change] of changes.entries()) {
      options = { ...options, ...change };
      await run();
      await run();
      expect(collectOcrHintsBatch).toHaveBeenCalledTimes(index + 2);
    }
  });

  it("invalidates stale hints after OCR grouping changes", async () => {
    const chapterDir = await mkdtemp(join(tmpdir(), "mgt-ocr-order-cache-"));
    tempDirs.push(chapterDir);
    const page = makePage();
    let freshText = "fresh-order-1";
    const collectOcrHintsBatch = vi.fn(async () => [
      {
        hints: [
          {
            id: 1,
            label: "ocr_textgroup",
            x1: 10,
            y1: 10,
            x2: 80,
            y2: 90,
            ocrText: freshText,
          },
        ],
        diagnostics: [],
        noTextDetected: false,
        textEvidenceCount: 1,
      },
    ]);
    const runtime = {
      collectOcrHintsBatch,
    } satisfies Pick<TranslationRuntimePort, "collectOcrHintsBatch">;
    const options = {
      sourceLanguage: "ja",
      ocrDevice: "gpu",
      ocrGpuBackend: "rocm-transformers",
      ocrQualityMode: "full",
      ocrBboxMode: "ocr",
      ocrEngine: "transformers",
      ocrMergeMode: "conservative",
    } as TranslationOptions;
    const run = () =>
      prepareOcrHintsForPages({
        runtime,
        baseOptions: options,
        pages: [page],
        runPaths: { chapterDir, runDir: join(chapterDir, "run") },
        emit: () => undefined,
        jobId: "job-order-cache",
        signal: new AbortController().signal,
      });
    const cachePath = join(chapterDir, "ocr-hints", page.id, "result.json");

    expect(readFirstOcrText(await run(), page.id)).toBe("fresh-order-1");
    const staleCache = JSON.parse(await readFile(cachePath, "utf8")) as {
      schemaVersion: number;
      hints: Array<{ ocrText?: string }>;
    };
    expect(staleCache.schemaVersion).toBe(9);
    staleCache.schemaVersion = 8;
    const staleHint = staleCache.hints[0];
    if (!staleHint) throw new Error("Expected one cached OCR hint");
    staleHint.ocrText = "stale-scrambled-order";
    await writeFile(
      cachePath,
      `${JSON.stringify(staleCache, null, 2)}\n`,
      "utf8",
    );

    freshText = "fresh-order-2";
    expect(readFirstOcrText(await run(), page.id)).toBe("fresh-order-2");
    expect(collectOcrHintsBatch).toHaveBeenCalledTimes(2);
    const rewrittenCache = JSON.parse(await readFile(cachePath, "utf8")) as {
      schemaVersion: number;
    };
    expect(rewrittenCache.schemaVersion).toBe(9);
  });
});

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "001.png",
    imagePath: "C:/manga/001.png",
    dataUrl: "data:image/png;base64,",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function readFirstOcrText(
  results: Awaited<ReturnType<typeof prepareOcrHintsForPages>>,
  pageId: string,
): string | undefined {
  return (results.get(pageId)?.hints[0] as { ocrText?: string } | undefined)
    ?.ocrText;
}
