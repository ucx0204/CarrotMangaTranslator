import { describe, expect, it, vi } from "vitest";
import { McpBlockOcrService, selectMcpBlockOcr } from "../src/main/application/mcpBlockOcrService";
import { createPageRevision } from "../src/shared/pageRevision";
import { editingFixture } from "./mcpEditing.fixture";

function fixture() {
  const f = editingFixture();
  const page = f.chapter.pages[0];
  const controller = new AbortController();
  const evidence = {
    engine: "hayai",
    sourceLanguage: "ja",
    sourceCropSha256: "a".repeat(64),
    recognizedText: "読み直し\n原文 🥕",
    regions: [{
      sequence: 0,
      sourceText: "読み直し\n原文 🥕",
      sourceRect: { x: 10, y: 20, w: 90, h: 120 },
      sourceDirection: "vertical" as const,
      textRole: "ordinary" as const,
    }],
  };
  const recognize = vi.fn<ConstructorParameters<typeof McpBlockOcrService>[0]["recognize"]>(async () => structuredClone(evidence));
  const service = new McpBlockOcrService({ openChapter: f.openChapter, recognize });
  const context = {
    id: "6aef15a8-38aa-4ed5-ad40-5e9b54607b23",
    signal: controller.signal,
    assertAuthorized: vi.fn(() => controller.signal.throwIfAborted()),
    progress: vi.fn(),
  };
  const target = {
    chapterId: "chapter", pageId: "page", blockId: "a",
    revision: createPageRevision(page),
    requestId: "c8023b83-98c1-435c-b111-789447debbd5",
  };
  return { ...f, page, controller, evidence, recognize, service, editor: f.service, context, target };
}

describe("read-only block OCR observations", () => {
  it("reads a single saved source rectangle, preserving the whole chapter until explicit application", async () => {
    const f = fixture();
    const before = structuredClone(f.chapter);
    const result = await f.service.run(f.target, f.context);
    expect(result).toMatchObject({
      status: "observed", pagesChanged: 0, performed: ["block-ocr"],
      noTextDetected: false, observationExpired: false,
      blockOcr: { previousSourceText: "source", recognizedText: f.evidence.recognizedText, differs: true },
    });
    expect(f.recognize).toHaveBeenCalledWith(
      expect.objectContaining({ imagePath: "/private/original.png" }),
      { x: 10, y: 20, w: 90, h: 120 }, f.context,
    );
    expect(f.chapter).toEqual(before);
    expect(f.savePageBlocks).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|\/private\/|dataUrl|inpaintMaskPath/);
    const applied = await f.editor.updateBlocks({
      ...f.target, revision: result.revision,
      edits: [{ blockId: "a", fields: { sourceText: result.blockOcr.recognizedText } }],
    });
    const expected = structuredClone(before);
    expected.pages[0].blocks[0].sourceText = f.evidence.recognizedText;
    expect(f.chapter).toEqual(expected);
    await f.editor.updateBlocks({
      ...f.target, revision: applied.revision,
      edits: [{ blockId: "a", fields: { sourceText: result.blockOcr.previousSourceText } }],
    });
    expect(f.chapter).toEqual(before);
  });

  it("uses a containing pixel crop without rewriting fractional source coordinates", () => {
    const f = fixture();
    f.page.blocks[0].bbox = { x: 10.25, y: 20.5, w: 90.5, h: 120.25 };
    const before = structuredClone(f.page);
    expect(selectMcpBlockOcr(f.page, "a")).toEqual({
      sourceRect: before.blocks[0].bbox,
      cropRect: { x: 10, y: 20, w: 91, h: 121 },
      previousSourceText: "source",
    });
    expect(f.page).toEqual(before);
    f.page.blocks[0].bboxSpace = "normalized_1000";
    f.page.blocks[0].bbox = { x: 100, y: 500, w: 200, h: 500 };
    expect(selectMcpBlockOcr(f.page, "a").cropRect).toEqual({ x: 100, y: 800, w: 200, h: 800 });
  });

  it.each([
    { x: 999, y: 0, w: 2, h: 10 },
    { x: -1, y: 0, w: 20, h: 10 },
    { x: 0, y: 0, w: 0, h: 10 },
    { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 10 },
  ])("rejects invalid source bounds before inference: %j", async (bbox) => {
    const f = fixture();
    f.page.blocks[0].bbox = bbox;
    f.target.revision = createPageRevision(f.page);
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({ code: "invalid_edit" });
    expect(f.recognize).not.toHaveBeenCalled();
  });

  it("rejects missing/duplicate IDs and stale snapshots before inference", async () => {
    const f = fixture();
    await expect(f.service.run({ ...f.target, blockId: "missing" }, f.context)).rejects.toMatchObject({ code: "not_found" });
    f.page.blocks[1].id = "a";
    f.target.revision = createPageRevision(f.page);
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({ code: "invalid_edit" });
    f.page.width++;
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.recognize).not.toHaveBeenCalled();
  });

  it("rejects a different chapter and a removed page", async () => {
    const f = fixture();
    f.chapter.id = "other";
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({ code: "not_found" });
    f.chapter.id = "chapter";
    f.chapter.pages = [];
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns empty and multi-region observations without clearing or splitting saved blocks", async () => {
    const f = fixture();
    const before = structuredClone(f.chapter);
    f.recognize.mockResolvedValueOnce({ ...f.evidence, recognizedText: "", regions: [] });
    const empty = await f.service.run(f.target, f.context);
    expect(empty.noTextDetected).toBe(true);
    expect(empty.blockOcr.warnings).toContain("no_text_keep_existing");
    f.recognize.mockResolvedValueOnce({ ...f.evidence, regions: [f.evidence.regions[0], { ...f.evidence.regions[0], sequence: 1 }] });
    expect((await f.service.run(f.target, f.context)).blockOcr.warnings).toContain("multiple_regions");
    expect(f.chapter).toEqual(before);
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });

  it("discards an observation when the page changes during recognition", async () => {
    const f = fixture();
    f.recognize.mockImplementationOnce(async () => {
      f.page.blocks[1].translatedText = "user changed this";
      return f.evidence;
    });
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });

  it("does not apply an old observation after a user edit", async () => {
    const f = fixture();
    const result = await f.service.run(f.target, f.context);
    f.page.blocks[1].translatedText = "manual change";
    await expect(f.editor.updateBlocks({
      ...f.target, revision: result.revision,
      edits: [{ blockId: "a", fields: { sourceText: result.blockOcr.recognizedText } }],
    })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });

  it("discards cancelled and revoked observations", async () => {
    const f = fixture();
    f.recognize.mockImplementationOnce(async () => { f.controller.abort(); return f.evidence; });
    await expect(f.service.run(f.target, f.context)).rejects.toThrow();
    const next = fixture();
    next.recognize.mockImplementationOnce(async () => {
      next.context.assertAuthorized.mockImplementation(() => { throw new Error("revoked"); });
      return next.evidence;
    });
    await expect(next.service.run(next.target, next.context)).rejects.toThrow("revoked");
    expect(next.savePageBlocks).not.toHaveBeenCalled();
  });

  it("rejects excessive text and regions without truncation", async () => {
    const f = fixture();
    f.recognize.mockResolvedValueOnce({ ...f.evidence, recognizedText: "x".repeat(20_001) });
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({ code: "invalid_edit" });
    f.recognize.mockResolvedValueOnce({ ...f.evidence, regions: Array.from({ length: 101 }, () => f.evidence.regions[0]) });
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({ code: "invalid_edit" });
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });
});
