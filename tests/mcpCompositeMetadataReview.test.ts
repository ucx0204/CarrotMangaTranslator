import { expect, it, vi } from "vitest";
import { ok } from "node:assert/strict";
import { inspectMcpCompositeMetadata } from "../src/main/application/mcpCompositeMetadataReview";
import { inspectMcpReviewPage } from "../src/main/application/mcpReviewPage";
import { McpReviewService } from "../src/main/application/mcpReviewService";
import { mcpReviewOutputSchemas } from "../src/shared/mcpReviewSchemas";
import { editingChapter } from "./mcpEditing.fixture";
import { compositeMetadataFixture } from "./mcpCompositeMetadata.fixture";

const first = { offset: 0, limit: 25 };

it("preserves the native saved-page concern rules and historical chapter output", async () => {
  const chapter = editingChapter();
  const page = chapter.pages[0];
  page.blocks[0].translatedText = "";
  page.blocks[0].inpaintExcluded = true;
  page.blocks[1].sourceText = " ";
  page.blocks[1].translatedText = "";
  page.blocks[1].reviewStatus = "reviewed";
  page.blocks[1].textRole = "ordinary";
  ok(page.blocks[1].generatedLettering);
  page.blocks[1].generatedLettering.enabled = false;
  page.analysisStatus = "failed";
  page.translationCompletion = {
    workflow: "erase-original",
    status: "pending",
  };
  const before = structuredClone(chapter);
  const preflight = vi.fn(async () => {
    throw new Error("Metadata review must not run export preflight");
  });
  const service = new McpReviewService({
    openChapter: async () => chapter,
    preflight,
  });
  const result = await service.chapter(chapter.id, first);
  expect(result.pages[0]).toEqual(inspectMcpReviewPage(page, 0));
  expect(result.pages[0].counts).toEqual({
    blocks: 2,
    untranslated: 1,
    missingSource: 1,
    unreviewed: 1,
    soundEffects: 1,
    excludedFromErasure: 1,
    staleLettering: 1,
  });
  expect(result.pages[0].concerns).toEqual([
    "untranslated",
    "unreviewed",
    "failed",
    "postprocess-pending",
    "stale-lettering",
  ]);
  expect(result.summary).toMatchObject({
    pages: 1,
    attention: 1,
    failed: 1,
    postprocessPending: 1,
  });
  expect(
    mcpReviewOutputSchemas.carrot_get_chapter_review.safeParse(result).success,
  ).toBe(true);
  expect(chapter).toEqual(before);
  expect(preflight).not.toHaveBeenCalled();
});

it("inspects only selected pages and discloses whole-page counts for a block-restricted parent", async () => {
  const f = compositeMetadataFixture();
  const unrelated = {
    ...structuredClone(f.chapter.pages[0]),
    id: "outside-parent",
  };
  Object.defineProperty(unrelated, "blocks", {
    get: () => {
      throw new Error("Unselected blocks were inspected");
    },
  });
  f.chapter.pages.push(unrelated);
  f.chapter.pageOrder.push(unrelated.id);
  f.ports.openChapter.mockImplementation(async () => f.chapter);
  const result = await inspectMcpCompositeMetadata(
    f.record,
    first,
    f.guard,
    f.ports,
  );
  expect(result).toMatchObject({
    scope: "selected-saved-metadata-only",
    total: 1,
    executionReserved: false,
  });
  expect(result.pages[0]).toMatchObject({
    workId: "work",
    chapterId: "chapter",
    blockScope: "whole-page-saved-metadata",
    review: { pageId: "page-0", counts: { blocks: 2 } },
  });
  expect(f.record.targets[0].blockIds).toHaveLength(1);
  expect(result).not.toHaveProperty("summary");
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE|private|original-a|sourceText|dataUrl/,
  );
  expect(f.ports.verifySources).toHaveBeenCalledTimes(2);
  expect(result.notChecked).toContain("translation-quality");
  expect(result.notChecked).toContain("existing-app-export-preflight");
});

it("paginates at most 25 of the bounded selected pages and rejects stale or absent continuation snapshots", async () => {
  const f = compositeMetadataFixture(26);
  const page = await inspectMcpCompositeMetadata(
    f.record,
    first,
    f.guard,
    f.ports,
  );
  expect(page.pages).toHaveLength(25);
  expect(page.nextOffset).toBe(25);
  const tail = await inspectMcpCompositeMetadata(
    f.record,
    { offset: 25, limit: 25, snapshot: page.snapshot },
    f.guard,
    f.ports,
  );
  expect(tail.pages.map((value) => value.review.pageId)).toEqual(["page-25"]);
  expect(tail.nextOffset).toBeNull();
  await expect(
    inspectMcpCompositeMetadata(
      f.record,
      { offset: 25, limit: 25 },
      f.guard,
      f.ports,
    ),
  ).rejects.toThrow("previous snapshot");
  await expect(
    inspectMcpCompositeMetadata(
      f.record,
      { offset: 0, limit: 26 },
      f.guard,
      f.ports,
    ),
  ).rejects.toThrow("1–25");
  f.record.version += 1;
  await expect(
    inspectMcpCompositeMetadata(
      f.record,
      { ...first, snapshot: page.snapshot },
      f.guard,
      f.ports,
    ),
  ).rejects.toMatchObject({ code: "revision_conflict" });
});

it("rejects a page or work that differs from the parent's captured selection", async () => {
  const f = compositeMetadataFixture();
  f.chapter.workId = "moved-work";
  await expect(
    inspectMcpCompositeMetadata(f.record, first, f.guard, f.ports),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  f.chapter.workId = "work";
  f.chapter.pages[0].blocks[0].translatedText = "Changed after parent capture";
  await expect(
    inspectMcpCompositeMetadata(f.record, first, f.guard, f.ports),
  ).rejects.toMatchObject({ code: "revision_conflict" });
});

it("rejects metadata changed between source checks without returning stale counts", async () => {
  const f = compositeMetadataFixture();
  f.ports.verifySources
    .mockImplementationOnce(async () => undefined)
    .mockImplementationOnce(async () => {
      f.chapter.pages[0].analysisStatus = "failed";
    });
  await expect(
    inspectMcpCompositeMetadata(f.record, first, f.guard, f.ports),
  ).rejects.toMatchObject({ code: "revision_conflict" });
});

it("propagates source authority and final authorization failures without weakening the snapshot", async () => {
  const f = compositeMetadataFixture();
  f.ports.verifySources.mockRejectedValueOnce(
    new Error("Exact source bytes changed"),
  );
  await expect(
    inspectMcpCompositeMetadata(f.record, first, f.guard, f.ports),
  ).rejects.toThrow("Exact source bytes changed");
  expect(f.ports.openChapter).not.toHaveBeenCalled();
  const controller = new AbortController();
  f.ports.verifySources
    .mockImplementationOnce(async () => undefined)
    .mockImplementationOnce(async () => {
      controller.abort(new Error("Read scope revoked"));
    });
  await expect(
    inspectMcpCompositeMetadata(
      f.record,
      first,
      () => controller.signal.throwIfAborted(),
      f.ports,
    ),
  ).rejects.toThrow("Read scope revoked");
});

it("reports an empty reviewed-import parent without inventing inspected pages", async () => {
  const f = compositeMetadataFixture(0);
  const result = await inspectMcpCompositeMetadata(
    f.record,
    first,
    f.guard,
    f.ports,
  );
  expect(result).toMatchObject({
    total: 0,
    pages: [],
    nextOffset: null,
    executionReserved: false,
  });
  expect(f.ports.openChapter).not.toHaveBeenCalled();
  expect(f.ports.verifySources).toHaveBeenCalledTimes(2);
});
