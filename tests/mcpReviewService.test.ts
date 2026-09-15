import { expect, it, vi } from "vitest";
import { McpReviewService } from "../src/main/application/mcpReviewService";
import { mcpReviewOutputSchemas } from "../src/shared/mcpReviewSchemas";
import type { PageImageExportPreflightResult } from "../src/shared/pageImageExportTypes";
import { editingChapter } from "./mcpEditing.fixture";

function fixture() {
  const chapter = editingChapter();
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const preflight = vi.fn(
    async (): Promise<PageImageExportPreflightResult> => ({
      workTitle: "private-title",
      chapterCount: 1,
      pageCount: 1,
      sampleRelativePath: "private/output.png",
      outputPolicy: "new-timestamped-folder",
      targets: [],
      issues: [
        {
          chapterId: "chapter",
          pageId: "page",
          chapterTitle: "private-title",
          pageName: "private-source.png",
          code: "translation-pending",
          severity: "warning",
        },
      ],
    }),
  );
  return {
    chapter,
    openChapter,
    preflight,
    service: new McpReviewService({ openChapter, preflight }),
  };
}
const window = { offset: 0, limit: 25 };
it("returns public counts without text, images, paths or source mutation", async () => {
  const f = fixture();
  const before = structuredClone(f.chapter);
  f.chapter.pages[0].blocks[0].translatedText = "";
  const source = structuredClone(f.chapter);
  const result = await f.service.chapter("chapter", window);
  expect(result.pages[0].counts).toMatchObject({
    blocks: 2,
    untranslated: 1,
    unreviewed: 2,
    soundEffects: 2,
    staleLettering: 1,
  });
  expect(result.summary).toMatchObject({
    pages: 1,
    attention: 1,
    untranslated: 1,
    staleLettering: 1,
  });
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE|private|original-a|sourceText/,
  );
  expect(f.chapter).toEqual(source);
  expect(before.pages[0].blocks).toHaveLength(2);
  expect(f.preflight).not.toHaveBeenCalled();
  expect(
    mcpReviewOutputSchemas.carrot_get_chapter_review.safeParse(result).success,
  ).toBe(true);
});
it("filters before paginating while summary counts remain chapter-wide", async () => {
  const f = fixture();
  const first = f.chapter.pages[0];
  const second = {
    ...structuredClone(first),
    id: "second",
    blocks: [],
    analysisStatus: "failed" as const,
  };
  f.chapter.pages.push(second);
  f.chapter.pageOrder.push("second");
  const result = await f.service.chapter(
    "chapter",
    { offset: 0, limit: 1 },
    "no-blocks",
  );
  expect(result.total).toBe(1);
  expect(result.pages[0].pageId).toBe("second");
  expect(result.pages[0].pageIndex).toBe(1);
  expect(result.summary.pages).toBe(2);
  expect(result.summary.failed).toBe(1);
  expect(result.nextOffset).toBeNull();
  const empty = await f.service.chapter(
    "chapter",
    { offset: 1, limit: 1 },
    "no-blocks",
  );
  expect(empty.pages).toEqual([]);
  expect(empty.total).toBe(1);
});
it("rejects changed chapter snapshots across paginated reads", async () => {
  const f = fixture();
  const first = await f.service.chapter("chapter", window);
  await expect(
    f.service.chapter("chapter", window, "all", first.snapshot),
  ).resolves.toMatchObject({ snapshot: first.snapshot });
  f.chapter.pages[0].blocks[0].translatedText = "manual edit";
  await expect(
    f.service.chapter("chapter", window, "all", first.snapshot),
  ).rejects.toMatchObject({ code: "revision_conflict" });
});
it("treats empty source, reviewed blocks and disabled artwork explicitly", async () => {
  const f = fixture();
  const page = f.chapter.pages[0];
  page.blocks.forEach((block) => {
    block.sourceText = " ";
    block.translatedText = "";
    block.reviewStatus = "reviewed";
    block.textRole = "ordinary";
    block.inpaintExcluded = true;
    if (block.generatedLettering) block.generatedLettering.enabled = false;
  });
  page.translationCompletion = {
    workflow: "erase-original",
    status: "pending",
  };
  const result = await f.service.chapter("chapter", window);
  expect(result.pages[0].counts).toEqual({
    blocks: 2,
    untranslated: 0,
    missingSource: 2,
    unreviewed: 0,
    soundEffects: 0,
    excludedFromErasure: 2,
    staleLettering: 0,
  });
  expect(result.pages[0].concerns).toEqual(["postprocess-pending"]);
  expect((await f.service.chapter("chapter", window, "unreviewed")).total).toBe(
    0,
  );
  expect((await f.service.chapter("chapter", window, "attention")).total).toBe(
    1,
  );
});
it("projects only desktop preflight issue codes and reports unchecked runtime conditions", async () => {
  const f = fixture();
  const result = await f.service.preflight("chapter", "page");
  expect(result.issues).toEqual([
    { code: "translation-pending", severity: "warning" },
  ]);
  expect(result.executionReserved).toBe(false);
  expect(result.notChecked).toContain(
    "image-transfer-permission-and-redaction",
  );
  expect(JSON.stringify(result)).not.toContain("private");
  expect(f.preflight).toHaveBeenCalledWith(f.chapter, "page");
  expect(
    mcpReviewOutputSchemas.carrot_preflight_page_export.safeParse(result)
      .success,
  ).toBe(true);
});
it("fails instead of returning stale preflight after saved status changes", async () => {
  const f = fixture();
  const existing = await f.preflight();
  f.preflight.mockImplementationOnce(async () => {
    f.chapter.pages[0].analysisStatus = "failed";
    return existing;
  });
  await expect(f.service.preflight("chapter", "page")).rejects.toMatchObject({
    code: "revision_conflict",
  });
});
it("refuses missing pages and propagates preflight failures without a fallback", async () => {
  const f = fixture();
  await expect(f.service.preflight("chapter", "missing")).rejects.toMatchObject(
    { code: "not_found" },
  );
  expect(f.preflight).not.toHaveBeenCalled();
  f.preflight.mockRejectedValueOnce(new Error("desktop preflight failed"));
  await expect(f.service.preflight("chapter", "page")).rejects.toThrow(
    "desktop preflight failed",
  );
});
it("supports an empty chapter without pretending any page has been processed", async () => {
  const f = fixture();
  f.chapter.pages = [];
  f.chapter.pageOrder = [];
  const result = await f.service.chapter("chapter", window);
  expect(result.total).toBe(0);
  expect(result.summary.pages).toBe(0);
  expect(result.nextOffset).toBeNull();
  expect(result.scope).toBe("saved-metadata-only");
  expect(f.preflight).not.toHaveBeenCalled();
});
