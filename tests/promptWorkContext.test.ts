import { describe, expect, it } from "vitest";
import { buildPromptWorkContextForPage } from "../src/main/pipeline/workContextPrompt";
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

describe("prompt work context", () => {
  it("injects enabled glossary and recent story memory without changing output schema", () => {
    const context = buildPromptWorkContextForPage({
      baseStyleGuide: makeStyleGuide(),
      storyMemory: makeStoryMemory(),
      pageId: "page-4",
      pageIndex: 4,
      recentPageCount: 2,
    });
    const prompt = promptRuntime.getOverlayPrompt(
      {
        imageWidth: 1000,
        imageHeight: 1400,
        workContext: context,
      },
      [{ role: "original", dataUrl: "data:image/png;base64,abc" }],
    );

    expect(prompt).toContain("# Work glossary and story memory");
    expect(prompt).toContain("魔王 => 마왕");
    expect(prompt).toContain("勇者");
    expect(prompt).not.toContain("비활성");
    expect(prompt).toContain("p3");
    expect(prompt).toContain("p4");
    expect(prompt).not.toContain("p1");
    expect(prompt).toContain("Do not output these notes as records.");
    expect(prompt).toContain(
      "Use exactly these keys, one per line: id, type, textRole, x1, y1, x2, y2, direction, angle, fontSize, confidence, jp, ko.",
    );
  });
});

function makeStyleGuide(): WorkStyleGuide {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    workId: "work-a",
    glossary: [
      {
        id: "glossary-1",
        source: "魔王",
        target: "마왕",
        category: "term",
        aliases: ["魔王様"],
        note: "칭호",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "glossary-2",
        source: "無効",
        target: "비활성",
        category: "term",
        enabled: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    characters: [
      {
        id: "character-1",
        displayName: "勇者",
        sourceNames: ["勇者"],
        targetName: "용사",
        speechStyle: "casual",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
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
  return {
    schemaVersion: 1,
    workId: "work-a",
    chapterId: "chapter-a",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pages: [0, 2, 3].map((pageIndex) => ({
      pageId: `page-${pageIndex}`,
      pageName: `${pageIndex + 1}.png`,
      pageIndex,
      sourceDigest: `source ${pageIndex}`,
      translatedDigest: `translated ${pageIndex}`,
      summary: `summary ${pageIndex}`,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}
