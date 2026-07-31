import { describe, expect, it, vi } from "vitest";
import type { TranslationOptions } from "../src/main/appSettings";
import { runSequentialWorkAnalysis } from "../src/main/workContextSequentialAnalysis";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type { WorkStyleGuide } from "../src/shared/workContextTypes";

describe("sequential work-context cancellation", () => {
  it("does not swallow an aborted chapter request or continue to later chapters", async () => {
    const controller = new AbortController();
    const disposeEndpoint = vi.fn(async () => undefined);
    const runChapterAnalysis = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });

    await expect(
      runSequentialWorkAnalysis({
        guide: makeGuide(),
        request: { chapterId: "chapter-1", scope: "work" },
        chapters: [makeChapter("chapter-1"), makeChapter("chapter-2")],
        workId: "work-1",
        options: {
          abortSignal: controller.signal,
          sourceLanguage: "ja",
          targetLanguage: "ko",
        } as TranslationOptions,
        maxInputChars: 12_000,
        runChapterAnalysis,
        startEndpointSession: async () => ({
          handle: {
            baseUrl: "http://127.0.0.1:1",
            child: null,
            startedByScript: false,
          },
          dispose: disposeEndpoint,
        }),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(runChapterAnalysis).toHaveBeenCalledOnce();
    expect(disposeEndpoint).toHaveBeenCalledOnce();
  });
});

function makeGuide(): WorkStyleGuide {
  return {
    schemaVersion: 1,
    workId: "work-1",
    glossary: [],
    characters: [],
    rules: {
      honorifics: "adapt",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChapter(id: string): ChapterSnapshot {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const pageId = `${id}-page`;
  return {
    id,
    workId: "work-1",
    title: id,
    sourceKind: "images",
    status: "completed",
    pageOrder: [pageId],
    pages: [
      {
        id: pageId,
        name: "001.png",
        imagePath: `C:/${pageId}.png`,
        dataUrl: "",
        width: 100,
        height: 100,
        blocks: [
          {
            id: `${pageId}-block`,
            type: "nonsolid",
            bbox: { x: 1, y: 1, w: 10, h: 10 },
            sourceText: "原文",
            translatedText: "번역",
            confidence: 1,
            sourceDirection: "horizontal",
            renderDirection: "horizontal",
            fontSizePx: 16,
            lineHeight: 1.2,
            textAlign: "center",
            textColor: "#000000",
            backgroundColor: "#ffffff",
            opacity: 1,
          },
        ],
        analysisStatus: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
