import { expect, it, vi } from "vitest";
import { editingChapter } from "./mcpEditing.fixture";
import { McpContextReferenceService } from "../src/main/application/mcpContextReferenceService";
import {
  McpContextReferencesSchema,
  mcpContextReferenceOutputs,
  type McpContextReferenceSnapshot,
} from "../src/shared/mcpContextReferences";

function fixture() {
  const first = editingChapter();
  const second = { ...structuredClone(first), id: "chapter-two" };
  first.pages[0].blocks[0].speakerId = "character";
  first.pages[0].blocks[0].glossaryEntryIds = [
    "term",
    "term",
    "gone",
    "disabled",
    "ambiguous",
    "__proto__",
  ];
  second.pages[0].blocks[0].speakerId = "disabled-character";
  const graph: McpContextReferenceSnapshot = {
    workId: "work",
    workTitle: "PRIVATE work title",
    styleGuide: {
      schemaVersion: 1,
      workId: "work",
      createdAt: "initial",
      updatedAt: "initial",
      rules: {
        honorifics: "adapt",
        sfxMode: "translate",
        defaultTone: "natural_korean",
      },
      glossary: ["term", "disabled", "ambiguous", "ambiguous", "__proto__"].map(
        (id) => ({
          id,
          source: "PRIVATE term",
          target: "PRIVATE translation",
          category: "term",
          enabled: id !== "disabled",
          createdAt: "initial",
          updatedAt: "initial",
        }),
      ),
      characters: ["character", "disabled-character"].map((id) => ({
        id,
        displayName: "PRIVATE name",
        sourceNames: [],
        targetName: "PRIVATE name",
        speechStyle: "neutral",
        enabled: id === "character",
        createdAt: "initial",
        updatedAt: "initial",
      })),
    },
    chapters: [first, second].map((chapter) => ({
      chapter,
      storyMemory: {
        schemaVersion: 1,
        workId: "work",
        chapterId: chapter.id,
        updatedAt: "initial",
        pages: [],
      },
    })),
  };
  graph.chapters[0].storyMemory.pages = [
    {
      pageId: "page",
      pageName: "PRIVATE name",
      pageIndex: 0,
      sourceDigest: "PRIVATE digest",
      translatedDigest: "PRIVATE digest",
      summary: "PRIVATE story",
      characterIds: ["character"],
      glossaryEntryIds: ["term"],
      updatedAt: "initial",
    },
    {
      pageId: "deleted-page",
      pageName: "PRIVATE name",
      pageIndex: 2,
      sourceDigest: "",
      translatedDigest: "",
      summary: "PRIVATE story",
      characterIds: ["missing-character"],
      updatedAt: "initial",
    },
    {
      pageId: "page",
      pageName: "PRIVATE name",
      pageIndex: 0,
      sourceDigest: "",
      translatedDigest: "",
      summary: "duplicate preserved",
      updatedAt: "initial",
    },
  ];
  const read = vi.fn(async () => graph);
  return {
    graph,
    read,
    service: new McpContextReferenceService(read),
    input: McpContextReferencesSchema.parse({ chapterId: "chapter" }),
  };
}

it("includes every chapter and orphaned memory without returning text images paths or mutating data", async () => {
  const f = fixture();
  const before = structuredClone(f.graph);
  const result = await f.service.inspect(f.input, () => {});
  expect(result.counts).toEqual({
    chapters: 2,
    pages: 2,
    blocks: 4,
    memories: 3,
    references: 11,
    active: 6,
    disabled: 2,
    missing: 2,
    ambiguous: 1,
    duplicateReferences: 1,
    orphanedMemories: 1,
    duplicateMemories: 1,
  });
  expect(result.references).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        chapterId: "chapter-two",
        pageId: "page",
        entryId: "disabled-character",
        status: "disabled",
      }),
      expect.objectContaining({
        memoryIndex: 1,
        pageId: "deleted-page",
        orphanedMemory: true,
        status: "missing",
      }),
      expect.objectContaining({ entryId: "__proto__", status: "active" }),
    ]),
  );
  expect(result.pagesChanged).toBe(0);
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE|imagePath|sourceText|translatedText|dataUrl|sourceDigest/,
  );
  expect(f.graph).toEqual(before);
  expect(
    mcpContextReferenceOutputs.carrot_get_context_references.parse(result),
  ).toEqual(result);
});

it("filters only the result list while preserving complete-work counts", async () => {
  const f = fixture();
  const issues = await f.service.inspect(
    { ...f.input, issuesOnly: true },
    () => {},
  );
  expect(issues.total).toBe(6);
  expect(issues.counts.references).toBe(11);
  const terms = await f.service.inspect(
    { ...f.input, entity: "glossary", entryIds: ["term"] },
    () => {},
  );
  expect(terms.total).toBe(3);
  expect(
    terms.references.every(
      (item) => item.entity === "glossary" && item.entryId === "term",
    ),
  ).toBe(true);
  const absent = await f.service.inspect(
    { ...f.input, entryIds: ["not-referenced"] },
    () => {},
  );
  expect(absent.total).toBe(0);
});

it("requires the exact snapshot for continuation and binds filters and the anchor", async () => {
  const f = fixture();
  const first = await f.service.inspect({ ...f.input, limit: 2 }, () => {});
  expect(first.nextOffset).toBe(2);
  const next = await f.service.inspect(
    { ...f.input, offset: 2, limit: 2, snapshot: first.snapshot },
    () => {},
  );
  expect(next.total).toBe(11);
  expect(next.references).toHaveLength(2);
  const last = await f.service.inspect(
    { ...f.input, offset: 100, snapshot: first.snapshot },
    () => {},
  );
  expect(last.references).toEqual([]);
  expect(last.nextOffset).toBeNull();
  await expect(
    f.service.inspect({ ...f.input, offset: 1 }, () => {}),
  ).rejects.toThrow();
  await expect(
    f.service.inspect(
      { ...f.input, snapshot: first.snapshot, issuesOnly: true },
      () => {},
    ),
  ).rejects.toThrow("Restart pagination");
  await expect(
    f.service.inspect(
      { ...f.input, snapshot: first.snapshot, chapterId: "chapter-two" },
      () => {},
    ),
  ).rejects.toThrow("Restart pagination");
});

it("ignores regenerated default root timestamps but rejects changed entry evidence and other chapter edits", async () => {
  const f = fixture();
  const initial = await f.service.inspect(f.input, () => {});
  f.graph.styleGuide.createdAt = "later";
  f.graph.styleGuide.updatedAt = "later";
  f.graph.chapters[0].storyMemory.updatedAt = "later";
  expect((await f.service.inspect(f.input, () => {})).snapshot).toBe(
    initial.snapshot,
  );
  f.graph.styleGuide.glossary[0].updatedAt = "changed-entry";
  await expect(
    f.service.inspect({ ...f.input, snapshot: initial.snapshot }, () => {}),
  ).rejects.toThrow("Restart pagination");
  const changed = await f.service.inspect(f.input, () => {});
  f.graph.chapters[1].chapter.pages[0].blocks[0].speakerId = "character";
  await expect(
    f.service.inspect({ ...f.input, snapshot: changed.snapshot }, () => {}),
  ).rejects.toThrow("Restart pagination");
});

it("rejects wrong work membership and ambiguous chapter or page identity", async () => {
  const f = fixture();
  await expect(
    f.service.inspect({ ...f.input, chapterId: "missing" }, () => {}),
  ).rejects.toThrow("anchor");
  f.graph.chapters[1].storyMemory.workId = "other";
  await expect(f.service.inspect(f.input, () => {})).rejects.toThrow(
    "membership",
  );
  f.graph.chapters[1].storyMemory.workId = "work";
  f.graph.chapters.push(f.graph.chapters[0]);
  await expect(f.service.inspect(f.input, () => {})).rejects.toThrow(
    "duplicate",
  );
  f.graph.chapters.pop();
  f.graph.chapters[0].chapter.pages.push(f.graph.chapters[0].chapter.pages[0]);
  await expect(f.service.inspect(f.input, () => {})).rejects.toThrow(
    "Duplicate saved page",
  );
});

it("checks authority before reading and after the asynchronous snapshot without returning data", async () => {
  const f = fixture();
  const denied = () => {
    throw new Error("revoked");
  };
  await expect(f.service.inspect(f.input, denied)).rejects.toThrow("revoked");
  expect(f.read).not.toHaveBeenCalled();
  let authorized = true;
  f.read.mockImplementation(async () => {
    authorized = false;
    return f.graph;
  });
  await expect(
    f.service.inspect(f.input, () => {
      if (!authorized) denied();
    }),
  ).rejects.toThrow("revoked");
});

it.each([
  { chapterId: "../private" },
  { chapterId: "chapter", path: "C:/private" },
  { chapterId: "chapter", entryIds: ["term", "term"] },
  { chapterId: "chapter", entity: "settings" },
  { chapterId: "chapter", offset: 1 },
  { chapterId: "chapter", limit: 101 },
  { chapterId: "chapter", entryIds: [] },
])("rejects undeclared reference inspection input %#", (input) => {
  expect(McpContextReferencesSchema.safeParse(input).success).toBe(false);
});
