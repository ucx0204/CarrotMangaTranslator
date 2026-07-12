import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import {
  buildPageStoryMemory,
  upsertPageStoryMemory,
} from "../src/main/pipeline/storyMemoryBuilder";

describe("story memory builder", () => {
  it("builds compact source and translated digests from page blocks", () => {
    const page = makePage({
      blocks: [
        { sourceText: "こんにちは", translatedText: "안녕" },
        { sourceText: "またね", translatedText: "또 봐", speakerId: "hero" },
      ],
    });

    const memory = buildPageStoryMemory({ page, pageIndex: 2 });

    expect(memory.pageId).toBe("page-a");
    expect(memory.pageIndex).toBe(2);
    expect(memory.sourceDigest).toBe("こんにちは / またね");
    expect(memory.translatedDigest).toBe("안녕 / 또 봐");
    expect(memory.characterIds).toEqual(["hero"]);
  });

  it("caps long summaries and upserts pages in pageIndex order", () => {
    const longText = "긴문장".repeat(300);
    const first = buildPageStoryMemory({
      page: makePage({
        id: "page-b",
        blocks: [{ sourceText: "長い", translatedText: longText }],
      }),
      pageIndex: 5,
    });
    const replacement = { ...first, summary: "교체", pageIndex: 1 };
    const second = buildPageStoryMemory({
      page: makePage({ id: "page-c" }),
      pageIndex: 3,
    });

    expect(first.summary.length).toBeLessThanOrEqual(400);

    const memory = upsertPageStoryMemory(
      upsertPageStoryMemory(
        {
          schemaVersion: 1,
          workId: "work-a",
          chapterId: "chapter-a",
          pages: [first],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        second,
      ),
      replacement,
    );

    expect(memory.pages.map((page) => page.pageId)).toEqual([
      "page-b",
      "page-c",
    ]);
    expect(memory.pages[0]?.summary).toBe("교체");
  });
});

function makePage({
  id = "page-a",
  blocks = [{ sourceText: "はい", translatedText: "응" }],
}: {
  id?: string;
  blocks?: Array<{
    sourceText: string;
    translatedText: string;
    speakerId?: string;
  }>;
}): MangaPage {
  return {
    id,
    name: "001.png",
    imagePath: "C:\\library\\page.png",
    dataUrl: "",
    width: 100,
    height: 120,
    blocks: blocks.map((block, index) => ({
      id: `block-${index + 1}`,
      type: "nonsolid",
      bbox: { x: 10, y: 10, w: 100, h: 100 },
      sourceText: block.sourceText,
      translatedText: block.translatedText,
      confidence: 0.9,
      sourceDirection: "vertical",
      renderDirection: "horizontal",
      fontSizePx: 20,
      lineHeight: 1.2,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#ffffff",
      opacity: 0.9,
      speakerId: block.speakerId,
    })),
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
