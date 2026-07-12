import { describe, expect, it } from "vitest";
import {
  buildWorkContextBudgetPreview,
  prunePromptWorkContextForBudget,
} from "../src/shared/workContextBudget";
import type {
  ChapterStoryMemory,
  PromptWorkContext,
  WorkStyleGuide,
} from "../src/shared/workContextTypes";

describe("work context token budget", () => {
  it("keeps all work context when output headroom is sufficient", () => {
    const context = makePromptWorkContext();
    const { budget, workContext } = prunePromptWorkContextForBudget(context, {
      ctx: 16384,
      maxTokens: 12000,
    });

    expect(budget.omittedParts).toEqual([]);
    expect(workContext.storyMemory.pages).toHaveLength(2);
    expect(workContext.styleGuide.glossary).toHaveLength(1);
    expect(workContext.styleGuide.characters).toHaveLength(1);
  });

  it("drops story memory first when it alone restores enough output headroom", () => {
    const context = makePromptWorkContext({ hugeStory: true });
    const { budget, workContext } = prunePromptWorkContextForBudget(context, {
      ctx: 8800,
      maxTokens: 12000,
    });

    expect(budget.omittedParts).toEqual(["storyMemory"]);
    expect(workContext.storyMemory.pages).toEqual([]);
    expect(workContext.styleGuide.glossary).toHaveLength(1);
    expect(workContext.styleGuide.characters).toHaveLength(1);
    expect(budget.effective.outputHeadroomTokens).toBeGreaterThanOrEqual(2048);
  });

  it("then drops glossary and characters if the budget is still too tight", () => {
    const context = makePromptWorkContext({ hugeStory: true });
    const { budget, workContext } = prunePromptWorkContextForBudget(context, {
      ctx: 6400,
      maxTokens: 12000,
    });

    expect(budget.omittedParts).toEqual([
      "storyMemory",
      "glossary",
      "characters",
    ]);
    expect(workContext.storyMemory.pages).toEqual([]);
    expect(workContext.styleGuide.glossary).toEqual([]);
    expect(workContext.styleGuide.characters).toEqual([]);
  });

  it("builds the same budget preview shape used by the style guide modal", () => {
    const preview = buildWorkContextBudgetPreview({
      ctx: 16384,
      maxTokens: 12000,
      storyMemory: makeStoryMemory(),
      styleGuide: makeStyleGuide(),
    });

    expect(preview.original.totalTokens).toBeGreaterThan(0);
    expect(preview.original.storyPageCount).toBe(2);
    expect(preview.original.outputHeadroomPercent).toBeGreaterThan(0);
  });
});

function makePromptWorkContext({
  hugeStory = false,
}: {
  hugeStory?: boolean;
} = {}): PromptWorkContext {
  return {
    styleGuide: makeStyleGuide(),
    storyMemory: makeStoryMemory(hugeStory),
    recentPageCount: 6,
  };
}

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
        note: "작중 칭호는 고정",
        enabled: true,
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

function makeStoryMemory(huge = false): ChapterStoryMemory {
  const summary = huge ? "긴 줄거리 ".repeat(900) : "이전 전투를 정리했다.";
  return {
    schemaVersion: 1,
    workId: "work-a",
    chapterId: "chapter-a",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pages: [0, 1].map((pageIndex) => ({
      pageId: `page-${pageIndex}`,
      pageName: `${pageIndex + 1}.png`,
      pageIndex,
      sourceDigest: `source ${pageIndex}`,
      translatedDigest: `translated ${pageIndex}`,
      summary,
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}
