import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createPageRevision } from "../src/shared/pageRevision";
import type { TranslationBlock } from "../src/shared/textTypes";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { McpSourceSizeObservation } from "../src/shared/mcpSourceSize";
import { McpSourceSizeService } from "../src/main/application/mcpSourceSizeService";
import { editingChapter } from "./mcpEditing.fixture";

type Estimate = McpSourceSizeObservation["items"][number]["estimate"];
const estimate: NonNullable<Estimate> = {
  facePx: 24,
  confidence: 0.8,
  method: "raster-core-v1",
};
function fixture() {
  const chapter = editingChapter();
  for (const block of chapter.pages[0].blocks) {
    delete block.generatedLettering;
    block.textRole = "ordinary";
  }
  const controller = new AbortController();
  const context = {
    id: randomUUID(),
    signal: controller.signal,
    assertAuthorized: vi.fn(() => controller.signal.throwIfAborted()),
    progress: vi.fn(),
  };
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const measure = vi.fn(
    async (_page: MangaPage, blocks: TranslationBlock[]) => ({
      sourceImageSha256: "a".repeat(64),
      estimates: blocks.map((): Estimate => ({ ...estimate })),
    }),
  );
  const service = new McpSourceSizeService(
    { openChapter, measure },
    () => 1000,
  );
  const target = () => ({
    chapterId: "chapter",
    pageId: "page",
    revision: createPageRevision(chapter.pages[0]),
    requestId: randomUUID(),
  });
  return {
    chapter,
    controller,
    context,
    openChapter,
    measure,
    service,
    target,
  };
}

it("returns bounded fresh raster evidence without writing or returning source contents", async () => {
  const f = fixture();
  const before = structuredClone(f.chapter);
  const result = await f.service.run(f.target(), f.context);
  expect(result.pagesChanged).toBe(0);
  expect(result.performed).toEqual(["source_size_measurement"]);
  expect(result.sourceSize.measuredBlocks).toBe(2);
  expect(result.sourceSize.items.map((item) => item.estimate)).toEqual([
    estimate,
    estimate,
  ]);
  expect(result.sourceSize.expiresAt).toBe(1801000);
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE|private|imagePath|sourceText|translatedText/,
  );
  expect(f.chapter).toEqual(before);
  expect(f.measure).toHaveBeenCalledOnce();
});

it("preserves manual sizes, generated lettering, sound effects and empty blocks", async () => {
  const f = fixture();
  const page = f.chapter.pages[0];
  const original = structuredClone(page.blocks[0]);
  page.blocks = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(original),
    id: `b${i}`,
  }));
  page.blocks[1].fontSizeIntent = "manual";
  page.blocks[2].generatedLettering = {
    version: 1,
    dataUrl: "PRIVATE",
    sourceText: "x",
    translatedText: "y",
  };
  page.blocks[3].textRole = "sound";
  page.blocks[4].sourceText = "  ";
  page.blocks[5].fontRole = "sfx_impact";
  const before = structuredClone(f.chapter);
  const result = await f.service.run(f.target(), f.context);
  expect(result.sourceSize.measuredBlocks).toBe(1);
  expect(result.sourceSize.items.map((item) => item.excludedReason)).toEqual([
    null,
    "manual_font_size_preserved",
    "generated_lettering",
    "sound_effect_out_of_scope",
    "empty_source",
    "sound_effect_out_of_scope",
  ]);
  expect(f.measure.mock.calls[0][1].map((block) => block.id)).toEqual(["b0"]);
  expect(f.chapter).toEqual(before);
});

it.each(["page", "work", "order"])(
  "refuses a changed %s after analysis",
  async (kind) => {
    const f = fixture();
    const target = f.target();
    f.measure.mockImplementationOnce(async (_page, blocks) => {
      if (kind === "page") f.chapter.pages[0].blocks[0].sourceText = "changed";
      if (kind === "work") f.chapter.workId = "moved";
      if (kind === "order") f.chapter.pageOrder = ["different", "page"];
      return {
        sourceImageSha256: "a".repeat(64),
        estimates: blocks.map(() => estimate),
      };
    });
    await expect(f.service.run(target, f.context)).rejects.toMatchObject({
      code: "revision_conflict",
    });
  },
);

it("rejects stale initial revisions and absent or ambiguous pages before measuring", async () => {
  const f = fixture();
  const target = f.target();
  await expect(
    f.service.run(
      { ...target, revision: "page-v1:0000000000000000" },
      f.context,
    ),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await expect(
    f.service.run({ ...target, pageId: "absent" }, f.context),
  ).rejects.toMatchObject({ code: "not_found" });
  f.chapter.pages.push(structuredClone(f.chapter.pages[0]));
  await expect(f.service.run(target, f.context)).rejects.toMatchObject({
    code: "not_found",
  });
  expect(f.measure).not.toHaveBeenCalled();
});

it("rejects invalid geometry, duplicate blocks and excessive inventories", async () => {
  const f = fixture();
  const page = f.chapter.pages[0];
  const original = structuredClone(page.blocks[0]);
  page.blocks[0].bbox.x = 1000;
  await expect(f.service.run(f.target(), f.context)).rejects.toMatchObject({
    code: "invalid_edit",
  });
  page.blocks = [original, structuredClone(original)];
  await expect(f.service.run(f.target(), f.context)).rejects.toMatchObject({
    code: "invalid_edit",
  });
  page.blocks = Array.from({ length: 1001 }, (_, i) => ({
    ...original,
    id: `b${i}`,
  }));
  await expect(f.service.run(f.target(), f.context)).rejects.toMatchObject({
    code: "invalid_edit",
  });
  expect(f.measure).not.toHaveBeenCalled();
});

it("does not invent a measurement when evidence is insufficient", async () => {
  const f = fixture();
  f.measure.mockResolvedValueOnce({
    sourceImageSha256: "a".repeat(64),
    estimates: [null, null],
  });
  const result = await f.service.run(f.target(), f.context);
  expect(result.sourceSize.measuredBlocks).toBe(0);
  expect(
    result.sourceSize.items.every(
      (item) => item.excludedReason === "insufficient_raster_evidence",
    ),
  ).toBe(true);
  f.measure.mockResolvedValueOnce({
    sourceImageSha256: "a".repeat(64),
    estimates: [],
  });
  await expect(f.service.run(f.target(), f.context)).rejects.toMatchObject({
    code: "invalid_edit",
  });
});

it("propagates cancellation and revoked authority without returning measurements", async () => {
  const f = fixture();
  f.measure.mockImplementationOnce(async (_page, blocks) => {
    f.controller.abort();
    return {
      sourceImageSha256: "a".repeat(64),
      estimates: blocks.map(() => estimate),
    };
  });
  await expect(f.service.run(f.target(), f.context)).rejects.toThrow();
  const denied = fixture();
  denied.context.assertAuthorized.mockImplementation(() => {
    throw new Error("revoked");
  });
  await expect(
    denied.service.run(denied.target(), denied.context),
  ).rejects.toThrow("revoked");
  expect(denied.measure).not.toHaveBeenCalled();
});

it("refuses empty selections without starting raster processing", async () => {
  const f = fixture();
  f.chapter.pages[0].blocks = [];
  await expect(f.service.run(f.target(), f.context)).rejects.toMatchObject({
    code: "invalid_edit",
  });
  expect(f.measure).not.toHaveBeenCalled();
});
