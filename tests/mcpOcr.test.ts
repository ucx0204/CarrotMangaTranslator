import { describe, expect, it, vi } from "vitest";
import { McpOcrService } from "../src/main/application/mcpOcrService";
import { mcpOcrReadingBlocks } from "../src/main/application/mcpOcrReadingPolicy";
import { McpReadingService } from "../src/main/application/mcpReadingService";
import { createPageRevision } from "../src/shared/pageRevision";
import { editingFixture } from "./mcpEditing.fixture";

function fixture() {
  const f = editingFixture();
  f.chapter.pages[0].blocks = [];
  f.chapter.pages[0].blockOrder = [];
  const reader = new McpReadingService({
    ...f,
    defaults: async () => undefined,
  });
  const recognize = vi.fn(async () => ({
    blocks: [
      {
        key: "1",
        sourceText: "原文",
        translatedText: "",
        sourceRect: { x: 10, y: 20, w: 50, h: 100 },
      },
    ],
    engine: "hayai",
    noTextDetected: false,
    effectReviewCandidates: 0,
  }));
  const service = new McpOcrService({
    openChapter: f.openChapter,
    recognize,
    saveReading: (reading, guard) => reader.create(reading, guard),
  });
  const context = {
    id: "job",
    signal: new AbortController().signal,
    progress: vi.fn(),
    assertAuthorized: vi.fn(),
  };
  const target = {
    chapterId: "chapter",
    pageId: "page",
    revision: createPageRevision(f.chapter.pages[0]),
    requestId: "ocr-request",
  };
  return { ...f, service, recognize, context, target };
}
describe("independent OCR", () => {
  it("saves only untranslated readings through the existing block transaction", async () => {
    const f = fixture();
    const result = await f.service.run(f.target, f.context);
    expect(result).toMatchObject({
      status: "saved",
      performed: ["ocr"],
      engine: "hayai",
      needsReview: true,
    });
    expect(f.chapter.pages[0].blocks[0]).toMatchObject({
      sourceText: "原文",
      translatedText: "",
      reviewStatus: "needs_review",
    });
    expect(f.chapter.pages[0].inpaintedImagePath).toBe("/private/clean.png");
    expect(f.savePageBlocks).toHaveBeenCalledTimes(1);
  });
  it("rejects existing blocks before invoking OCR", async () => {
    const f = fixture();
    f.chapter.pages[0].blocks = editingFixture().chapter.pages[0].blocks;
    f.target.revision = createPageRevision(f.chapter.pages[0]);
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({
      code: "invalid_edit",
    });
    expect(f.recognize).not.toHaveBeenCalled();
  });
  it("rejects edits and revocation occurring during recognition", async () => {
    const f = fixture();
    f.recognize.mockImplementationOnce(async () => {
      f.chapter.pages[0].width++;
      return {
        blocks: [],
        engine: "hayai",
        noTextDetected: true,
        effectReviewCandidates: 0,
      };
    });
    await expect(f.service.run(f.target, f.context)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.savePageBlocks).not.toHaveBeenCalled();
    const next = fixture();
    next.recognize.mockImplementationOnce(async () => {
      next.context.assertAuthorized.mockImplementation(() => {
        throw new Error("revoked");
      });
      return {
        blocks: [],
        engine: "hayai",
        noTextDetected: true,
        effectReviewCandidates: 0,
      };
    });
    await expect(next.service.run(next.target, next.context)).rejects.toThrow(
      "revoked",
    );
    expect(next.savePageBlocks).not.toHaveBeenCalled();
  });
  it("keeps no-text results as an OCR observation, not a completed translation", async () => {
    const f = fixture();
    f.recognize.mockResolvedValueOnce({
      blocks: [],
      engine: "paddleocr",
      noTextDetected: true,
      effectReviewCandidates: 3,
    });
    const result = await f.service.run(f.target, f.context);
    expect(result).toMatchObject({
      status: "no_blocks",
      noTextDetected: true,
      effectReviewCandidates: 3,
    });
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });
  it("adapts final OCR pixel hints without inventing translations", () => {
    const page = editingFixture().chapter.pages[0];
    expect(
      mcpOcrReadingBlocks(page, [
        {
          x1: 10.2,
          y1: 20.4,
          x2: 50.9,
          y2: 99.2,
          ocrText: "原文",
          direction: "vertical",
        },
      ])[0],
    ).toMatchObject({
      sourceRect: { x: 10, y: 20, w: 41, h: 80 },
      sourceText: "原文",
      translatedText: "",
      sourceDirection: "vertical",
    });
    expect(() =>
      mcpOcrReadingBlocks(page, [{ x1: -100, x2: -10, y1: 0, y2: 10 }]),
    ).toThrow();
    expect(() => mcpOcrReadingBlocks(page, [{ x1: "bad" }])).toThrow();
  });
});
