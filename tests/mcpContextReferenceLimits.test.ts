import { expect, it } from "vitest";
import { editingChapter } from "./mcpEditing.fixture";
import { McpContextReferenceService } from "../src/main/application/mcpContextReferenceService";
import {
  McpContextReferencesSchema,
  type McpContextReferenceSnapshot,
} from "../src/shared/mcpContextReferences";

function fixture() {
  const chapter = editingChapter();
  const graph: McpContextReferenceSnapshot = {
    workId: "work",
    workTitle: "Empty reference catalog",
    styleGuide: {
      schemaVersion: 1,
      workId: "work",
      glossary: [],
      characters: [],
      rules: {
        honorifics: "adapt",
        sfxMode: "translate",
        defaultTone: "natural_korean",
      },
      createdAt: "now",
      updatedAt: "now",
    },
    chapters: [
      {
        chapter,
        storyMemory: {
          schemaVersion: 1,
          workId: "work",
          chapterId: "chapter",
          pages: [],
          updatedAt: "now",
        },
      },
    ],
  };
  const input = McpContextReferencesSchema.parse({ chapterId: "chapter" });
  const service = new McpContextReferenceService(async () => graph);
  return {
    graph,
    inspect: (guard = () => {}) => service.inspect(input, guard),
  };
}

it("returns a genuine empty inventory without inventing links", async () => {
  const f = fixture();
  const result = await f.inspect();
  expect(result.total).toBe(0);
  expect(result.references).toEqual([]);
  expect(result.nextOffset).toBeNull();
  expect(result.counts).toMatchObject({
    chapters: 1,
    pages: 1,
    blocks: 2,
    memories: 0,
    references: 0,
  });
});

it("rejects the complete work when its chapter cap is exceeded", async () => {
  const f = fixture();
  const seed = f.graph.chapters[0];
  f.graph.chapters = Array.from({ length: 101 }, (_, index) => {
    const id = index === 0 ? "chapter" : `chapter-${index}`;
    return {
      chapter: { ...seed.chapter, id },
      storyMemory: { ...seed.storyMemory, chapterId: id },
    };
  });
  await expect(f.inspect()).rejects.toThrow("inspection limit");
});

it("rejects too many pages without returning a filtered partial inventory", async () => {
  const f = fixture();
  const chapter = f.graph.chapters[0].chapter;
  chapter.pages = Array.from({ length: 1001 }, (_, index) => ({
    ...chapter.pages[0],
    id: `page-${index}`,
    blocks: [],
  }));
  await expect(f.inspect()).rejects.toThrow("snapshot budget");
});

it("rejects too many blocks before materializing reference results", async () => {
  const f = fixture();
  const page = f.graph.chapters[0].chapter.pages[0];
  const block = page.blocks[0];
  page.blocks = Array.from({ length: 100001 }, (_, index) => ({
    ...block,
    id: `block-${index}`,
  }));
  await expect(f.inspect()).rejects.toThrow("snapshot budget");
});

it("rejects too many memory rows even when they contain no references", async () => {
  const f = fixture();
  const memory = {
    pageId: "page",
    pageName: "page",
    pageIndex: 0,
    sourceDigest: "",
    translatedDigest: "",
    summary: "",
    updatedAt: "now",
  };
  f.graph.chapters[0].storyMemory.pages = Array.from(
    { length: 200001 },
    () => memory,
  );
  await expect(f.inspect()).rejects.toThrow("snapshot budget");
});

it("does not conflate duplicate block identities or another work's guide", async () => {
  const f = fixture();
  const page = f.graph.chapters[0].chapter.pages[0];
  page.blocks.push(page.blocks[0]);
  await expect(f.inspect()).rejects.toThrow("Duplicate saved block");
  page.blocks.pop();
  f.graph.styleGuide.workId = "other";
  await expect(f.inspect()).rejects.toThrow("anchor");
});

it("observes revocation while collecting a multi-page snapshot", async () => {
  const f = fixture();
  let calls = 0;
  await expect(
    f.inspect(() => {
      calls++;
      if (calls === 3) throw new Error("revoked during enumeration");
    }),
  ).rejects.toThrow("revoked during enumeration");
});
