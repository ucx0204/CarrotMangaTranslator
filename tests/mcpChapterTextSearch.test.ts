import { expect, it } from "vitest";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import { searchMcpChapterText } from "../src/main/application/mcpChapterTextSearch";
import {
  McpChapterTextSearchSchema,
  mcpTranslationBatchOutputs,
} from "../src/shared/mcpTranslationBatch";

it("browses in page/reading order, returns neighbors and never leaks paths or image bytes", () => {
  const f = translationBatchFixture();
  const before = structuredClone(f.saved);
  const request = McpChapterTextSearchSchema.parse({
    chapterId: "chapter",
    mode: "browse",
    limit: 2,
  });
  const first = searchMcpChapterText(f.saved, request);
  expect(first.total).toBe(6);
  expect(first.matches.map((hit) => hit.blockId)).toEqual(["b", "a"]);
  expect(first.matches[0].next?.blockId).toBe("a");
  expect(first.matches[1].previous?.blockId).toBe("b");
  const next = searchMcpChapterText(f.saved, {
    ...request,
    snapshot: first.snapshot,
    offset: first.nextOffset!,
  });
  expect(next.matches[0].pageId).toBe("second");
  expect(f.saved).toEqual(before);
  expect(JSON.stringify(first)).not.toMatch(/PRIVATE|imagePath|dataUrl|mask/);
  expect(
    mcpTranslationBatchOutputs.carrot_search_chapter_text.safeParse(first)
      .success,
  ).toBe(true);
});
it("finds literal names but leaves semantic decisions to the AI", () => {
  const f = translationBatchFixture();
  f.chapter.pages[0].blocks[0].translatedText = "리오가 리오에게 말했다.";
  const request = McpChapterTextSearchSchema.parse({
    chapterId: "chapter",
    mode: "search",
    query: "리오",
    field: "translation",
  });
  const result = searchMcpChapterText(f.saved, request);
  expect(result.total).toBe(1);
  expect(result.matches[0].matches).toEqual([
    { field: "translation", start: 0, end: 2 },
    { field: "translation", start: 4, end: 6 },
  ]);
  expect(
    searchMcpChapterText(f.saved, { ...request, match: "exact" }).total,
  ).toBe(0);
  expect(searchMcpChapterText(f.saved, { ...request, query: ".*" }).total).toBe(
    0,
  );
});
it("bounds occurrences and UTF-16 snippets without breaking surrogate pairs", () => {
  const f = translationBatchFixture();
  f.chapter.pages[0].blocks[0].translatedText = "😀".repeat(1000) + "TARGET";
  const request = McpChapterTextSearchSchema.parse({
    chapterId: "chapter",
    mode: "search",
    query: "😀",
    field: "translation",
  });
  const result = searchMcpChapterText(f.saved, request).matches[0];
  expect(result.matches).toHaveLength(20);
  expect(result.matchesTruncated).toBe(true);
  expect(result.translation.truncated).toBe(true);
  expect(result.matches[1]).toMatchObject({ start: 2, end: 4 });
  const far = searchMcpChapterText(f.saved, { ...request, query: "TARGET" })
    .matches[0];
  expect(far.translation.text).toContain("TARGET");
  expect(far.translation.text).not.toMatch(
    /(^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$)/,
  );
});
it("counts excluded generated text and honors role/review/page filters", () => {
  const f = translationBatchFixture();
  const block = f.chapter.pages[1].blocks[0];
  block.textRole = "sound";
  block.reviewStatus = "reviewed";
  block.generatedLettering = {
    version: 1,
    dataUrl: "PRIVATE",
    sourceText: "source",
    translatedText: block.translatedText,
  };
  const request = McpChapterTextSearchSchema.parse({
    chapterId: "chapter",
    mode: "browse",
    pageIds: ["second"],
    textRole: "sound",
    reviewStatus: "reviewed",
  });
  const excluded = searchMcpChapterText(f.saved, request);
  expect(excluded.total).toBe(0);
  expect(excluded.excludedGenerated).toBe(1);
  const only = searchMcpChapterText(f.saved, { ...request, generated: "only" });
  expect(only.matches[0]).toMatchObject({
    editable: false,
    hasGeneratedLettering: true,
  });
  expect(
    searchMcpChapterText(f.saved, { ...request, generated: "include" }).total,
  ).toBe(1);
});
it.each([
  { mode: "search", query: " " },
  { mode: "browse", query: "x" },
  { mode: "browse", offset: 1 },
  { mode: "browse", pageIds: ["page", "page"] },
  { mode: "browse", pageIds: ["absent"] },
])("rejects ambiguous/unanchored input without broadening scope: %j", (bad) => {
  const f = translationBatchFixture();
  const request = McpChapterTextSearchSchema.parse({
    chapterId: "chapter",
    ...bad,
  });
  expect(() => searchMcpChapterText(f.saved, request)).toThrow();
});
it("invalidates a snapshot on page/context/order or search-criteria changes", () => {
  const f = translationBatchFixture();
  const request = McpChapterTextSearchSchema.parse({
    chapterId: "chapter",
    mode: "browse",
    limit: 1,
  });
  const first = searchMcpChapterText(f.saved, request);
  const next = { ...request, snapshot: first.snapshot, offset: 1 };
  expect(() =>
    searchMcpChapterText(f.saved, { ...next, textRole: "sound" }),
  ).toThrow(/changed/);
  f.saved.styleGuide.rules.honorifics = "drop";
  expect(() => searchMcpChapterText(f.saved, next)).toThrow(/changed/);
  f.saved.styleGuide.rules.honorifics = "adapt";
  f.chapter.pages[2].blocks[0].translatedText += " edited";
  expect(() => searchMcpChapterText(f.saved, next)).toThrow(/changed/);
});
it("rejects corrupted duplicate stored identities and wrong chapter ownership", () => {
  const f = translationBatchFixture();
  const request = McpChapterTextSearchSchema.parse({
    chapterId: "chapter",
    mode: "browse",
  });
  f.chapter.pages[0].blocks[1].id = "a";
  expect(() => searchMcpChapterText(f.saved, request)).toThrow(/Duplicate/);
  f.chapter.pages[0].blocks[1].id = "b";
  f.chapter.pages[1].id = "page";
  expect(() => searchMcpChapterText(f.saved, request)).toThrow(/Duplicate/);
  f.saved.workId = "another-work";
  expect(() => searchMcpChapterText(f.saved, request)).toThrow(/membership/);
});
