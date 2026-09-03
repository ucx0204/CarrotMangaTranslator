import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("electron");
  vi.resetModules();
});

describe("work-context research postprocess worker boundary", () => {
  it("loads and postprocesses without the Electron module", async () => {
    vi.resetModules();
    vi.doMock("electron", () => {
      throw Object.assign(new Error("Cannot find module 'electron'"), {
        code: "MODULE_NOT_FOUND",
      });
    });

    const { postprocessWorkContextResearch } =
      await import("../src/main/workContextResearchPostprocess");

    expect(postprocessWorkContextResearch(makeInput())).toEqual({
      operations: [],
      warnings: [],
      estimatedTokenDelta: 0,
    });
  });
});

function makeInput() {
  return {
    raw: { operations: [], warnings: [] },
    promptInput: {
      workTitle: "테스트 작품",
      guide: {
        schemaVersion: 1 as const,
        workId: "work-1",
        glossary: [],
        characters: [],
        rules: {
          honorifics: "preserve" as const,
          sfxMode: "translate" as const,
          defaultTone: "natural_korean" as const,
        },
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
      },
      selection: {
        text: "",
        basePages: [],
        coverage: {
          scope: "work" as const,
          workId: "work-1",
          requestedChapterId: "chapter-1",
          totalChapters: 1,
          includedChapters: 0,
          totalPages: 0,
          includedPages: 0,
          selectedChars: 0,
          maxInputChars: 65_536,
          truncated: false,
        },
      },
    },
    usage: { workId: "work-1", glossary: [], characters: [] },
  };
}
