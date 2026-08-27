import { describe, expect, it } from "vitest";
import { buildPromptWorkContextForPage } from "../src/main/pipeline/workContextPrompt";
import { collectOcrTextEvidence } from "../src/main/pipeline/pageContextEvidence";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../src/shared/workContextTypes";

const promptRuntime =
  require("../src/main/runtime/simple-page-prompts.cjs") as {
    getOverlayPrompt: (
      options?: Record<string, unknown>,
      imageVariants?: Array<Record<string, unknown>>,
    ) => string;
  };

describe("cumulative translation prompt", () => {
  it("requests a delimited context trailer only when collection is enabled", () => {
    const cumulative = promptRuntime.getOverlayPrompt(
      { collectPageContext: true },
      [{ role: "original" }],
    );
    const standard = promptRuntime.getOverlayPrompt(
      { collectPageContext: false },
      [{ role: "original" }],
    );

    expect(cumulative).toContain("# Page context trailer");
    expect(cumulative).toContain("<page-context>");
    expect(cumulative).toContain('"visualSummary"');
    expect(cumulative).toContain(
      "the only JSON exception is the required <page-context> trailer",
    );
    expect(cumulative).not.toContain(
      "Return plain text records only. Do not output JSON",
    );
    expect(cumulative).toContain(
      "When the page has no readable source text, output no translation records",
    );
    expect(standard).not.toContain("<page-context>");
    expect(standard).toContain(
      "Return plain text records only. Do not output JSON",
    );
  });

  it("adds selective glossary instructions for balanced and essential collection", () => {
    const balanced = promptRuntime.getOverlayPrompt(
      { collectPageContext: true, cumulativeContextDetail: "balanced" },
      [{ role: "original" }],
    );
    const essential = promptRuntime.getOverlayPrompt(
      { collectPageContext: true, cumulativeContextDetail: "essential" },
      [{ role: "original" }],
    );

    expect(balanced).toContain("Use a selective glossary focused on names");
    expect(essential).toContain("Keep glossary extremely small");
  });

  it("prefers visual summaries and ranks direct OCR matches before usage", () => {
    const guide = makeStyleGuide();
    const memory = makeStoryMemory();
    const context = buildPromptWorkContextForPage({
      baseStyleGuide: guide,
      storyMemory: memory,
      pageId: "page-current",
      pageIndex: 5,
      ocrHints: [{ ocrText: "直接語" }],
    });
    const prompt = promptRuntime.getOverlayPrompt({ workContext: context }, [
      { role: "original" },
    ]);

    expect(context.styleGuide.glossary.map((entry) => entry.id)).toEqual([
      "direct",
      "frequent",
    ]);
    expect(prompt).toContain("그림을 보고 만든 장면 요약");
    expect(prompt).not.toContain("낡은 텍스트 요약");
  });

  it("does not treat OCR detector labels as source-text evidence", () => {
    expect(
      collectOcrTextEvidence([
        { label: "ocr_textline", ocrText: "実際の原文" },
        { label: "text" },
      ]),
    ).toEqual(["実際の原文"]);
  });

  it("uses all prior chapters for ranking but only the latest six in the prompt", () => {
    const guide = makeStyleGuide();
    const frequent = guide.glossary[0];
    const direct = guide.glossary[1];
    if (!frequent || !direct) throw new Error("test glossary missing");
    guide.glossary = [direct, frequent];
    const previousStoryPages = Array.from({ length: 7 }, (_, index) => ({
      pageId: `previous-${index}`,
      pageName: `이전화 · ${index + 1}.png`,
      pageIndex: index - 7,
      sourceDigest: `source ${index}`,
      translatedDigest: `translated ${index}`,
      summary: `이전 장면 ${index}`,
      glossaryEntryIds: index === 0 ? ["frequent"] : [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    const context = buildPromptWorkContextForPage({
      baseStyleGuide: guide,
      storyMemory: { ...makeStoryMemory(), pages: [] },
      previousStoryPages,
      pageId: "page-current",
      pageIndex: 0,
      recentPageCount: 6,
    });
    const prompt = promptRuntime.getOverlayPrompt({ workContext: context }, [
      { role: "original" },
    ]);

    expect(context.styleGuide.glossary[0]?.id).toBe("frequent");
    expect(context.storyMemory.pages).toHaveLength(6);
    expect(prompt).not.toContain("이전 장면 0");
    expect(prompt).toContain("이전 장면 6");
    expect(prompt).not.toContain("p0 이전화");
  });
});

function makeStyleGuide(): WorkStyleGuide {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    workId: "work-a",
    glossary: [
      {
        id: "frequent",
        source: "頻出語",
        target: "빈출어",
        category: "term",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "direct",
        source: "直接語",
        target: "직접어",
        category: "term",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    characters: [],
    rules: {
      honorifics: "adapt",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function makeStoryMemory(): ChapterStoryMemory {
  const pages = [0, 1, 2].map((pageIndex) => ({
    pageId: `page-${pageIndex}`,
    pageName: `${pageIndex + 1}.png`,
    pageIndex,
    sourceDigest: "source",
    translatedDigest: "translated",
    summary: pageIndex === 2 ? "낡은 텍스트 요약" : `summary ${pageIndex}`,
    visualSummary: pageIndex === 2 ? "그림을 보고 만든 장면 요약" : undefined,
    glossaryEntryIds: ["frequent"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  return {
    schemaVersion: 1,
    workId: "work-a",
    chapterId: "chapter-a",
    pages,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
