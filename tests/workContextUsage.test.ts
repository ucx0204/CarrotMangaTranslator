import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChapterStoryMemory: vi.fn(),
  getWorkStyleGuide: vi.fn(),
  listLibrary: vi.fn(),
  openChapter: vi.fn(),
}));

vi.mock("../src/main/library", () => mocks);

import {
  buildWorkContextUsage,
  countTextMentions,
} from "../src/main/workContextUsage";

const TS = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listLibrary.mockResolvedValue({
    workOrder: ["work-1"],
    works: [
      {
        id: "work-1",
        title: "작품",
        chapterOrder: ["chapter-1"],
        chapters: [
          {
            id: "chapter-1",
            workId: "work-1",
            title: "1화",
            status: "completed",
            pageCount: 2,
            createdAt: TS,
            updatedAt: TS,
          },
        ],
        createdAt: TS,
        updatedAt: TS,
      },
    ],
  });
  mocks.getWorkStyleGuide.mockResolvedValue({
    schemaVersion: 1,
    workId: "work-1",
    glossary: [
      {
        id: "hero",
        source: "勇者",
        target: "용사",
        category: "term",
        aliases: ["ゆうしゃ"],
        enabled: true,
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    characters: [
      {
        id: "aria",
        displayName: "아리아",
        sourceNames: ["アリア"],
        targetName: "아리아",
        speechStyle: "neutral",
        enabled: true,
        createdAt: TS,
        updatedAt: TS,
      },
    ],
    rules: {
      honorifics: "preserve",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: TS,
    updatedAt: TS,
  });
  mocks.openChapter.mockResolvedValue({
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: ["page-1", "page-2"],
    pages: [
      makePage("page-1", "001.png", "勇者と勇者、アリア", "aria"),
      makePage("page-2", "002.png", "ゆうしゃが現れた"),
    ],
    createdAt: TS,
    updatedAt: TS,
  });
  mocks.getChapterStoryMemory.mockResolvedValue({
    schemaVersion: 1,
    workId: "work-1",
    chapterId: "chapter-1",
    pages: [
      {
        pageId: "page-2",
        pageName: "002.png",
        pageIndex: 99,
        sourceDigest: "",
        translatedDigest: "",
        summary: "",
        characterIds: ["aria"],
        updatedAt: TS,
      },
      {
        pageId: "deleted-page",
        pageName: "deleted.png",
        pageIndex: 2,
        sourceDigest: "",
        translatedDigest: "",
        summary: "",
        glossaryEntryIds: ["hero"],
        characterIds: ["aria"],
        updatedAt: TS,
      },
    ],
    updatedAt: TS,
  });
});

describe("work context usage", () => {
  it("derives unique-page counts from live pages without duplicate accumulation", async () => {
    const first = await buildWorkContextUsage("work-1");
    const second = await buildWorkContextUsage("work-1");

    expect(first).toEqual(second);
    expect(first.glossary).toEqual([
      expect.objectContaining({
        id: "hero",
        pageCount: 2,
        mentionCount: 3,
        lastSeen: expect.objectContaining({ pageId: "page-2", pageIndex: 1 }),
      }),
    ]);
    expect(first.characters).toEqual([
      expect.objectContaining({
        id: "aria",
        pageCount: 2,
        mentionCount: 1,
        lastSeen: expect.objectContaining({ pageId: "page-2", pageIndex: 1 }),
      }),
    ]);
  });

  it("normalizes text and avoids double-counting overlapping aliases", () => {
    expect(countTextMentions("ＡＢＣ abc", ["abc", "ab"])).toBe(2);
    expect(countTextMentions("勇者勇者", ["勇者"])).toBe(2);
  });
});

function makePage(
  id: string,
  name: string,
  sourceText: string,
  speakerId?: string,
) {
  return {
    id,
    name,
    imagePath: `C:\\library\\${name}`,
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 100,
    blocks: [
      {
        id: `${id}-block`,
        type: "nonsolid",
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        sourceText,
        translatedText: "",
        confidence: 1,
        sourceDirection: "horizontal",
        renderDirection: "horizontal",
        fontSizePx: 16,
        lineHeight: 1.2,
        textAlign: "left",
        textColor: "#000000",
        backgroundColor: "#ffffff",
        opacity: 1,
        speakerId,
      },
    ],
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
}
