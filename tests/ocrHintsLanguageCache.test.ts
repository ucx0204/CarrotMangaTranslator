import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/types";
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
    } as unknown as TranslationRuntimePort;

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
