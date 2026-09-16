import { describe, expect, it } from "vitest";
import { applyMcpSourceRect } from "../src/main/application/mcpSourceRectPolicy";
import { McpSourceRectPatchSchema } from "../src/shared/mcpSourceRect";
import { resolveBlockRenderBbox, resolveEffectiveRenderBbox } from "../src/shared/geometry";
import { parseRichText } from "../src/shared/richTextMarkup";
import { editingChapter } from "./mcpEditing.fixture";

const request = { chapterId: "chapter", pageId: "page", blockId: "a", revision: "page-v1:0000000000000000", sourceRect: { x: 200, y: 320, w: 300, h: 160 } };
function page() { return editingChapter().pages[0]; }
describe("source-only rectangle policy", () => {
  it("changes only the selected source box and preserves text, layout, masks and images", () => {
    const source = page(), before = structuredClone(source);
    const result = applyMcpSourceRect(source, request);
    expect(source).toEqual(before);
    expect(result.blocks).toEqual([{ ...before.blocks[0], bbox: { x: 200, y: 200, w: 300, h: 100 }, bboxSpace: "normalized_1000" }, before.blocks[1]]);
    expect(result.blocks[1]).toBe(source.blocks[1]);
    expect(result.blockOrder).toBe(source.blockOrder);
    expect(result.result).toMatchObject({ changed: true, sourceRect: request.sourceRect, previousSourceRect: { x: 10, y: 20, w: 90, h: 120 }, renderFramePinned: false });
    expect(result.result.warnings).toEqual(["source_text_not_rechecked", "erasure_and_masks_retained", "generated_lettering_retained"]);
    expect(JSON.stringify(result.result)).not.toMatch(/PRIVATE|private|sourceText|dataUrl/);
  });
  it("does not touch an equivalent existing pixel box", () => {
    const source = page();
    const result = applyMcpSourceRect(source, { ...request, sourceRect: source.blocks[0].bbox });
    expect(result.changed).toBe(false);
    expect(result.blocks[0]).toBe(source.blocks[0]);
    expect(result.result.warnings).toEqual([]);
  });
  it("pins the old expanded text frame when legacy blocks lack a render box", () => {
    const source = page(), block = source.blocks[0];
    delete block.renderBbox;
    delete block.generatedLettering;
    block.translatedText = "A much longer translated sentence with <b>markup</b>";
    const plain = parseRichText(block.translatedText).plainText;
    const before = resolveEffectiveRenderBbox(block, source, plain);
    const result = applyMcpSourceRect(source, request);
    expect(result.result.renderFramePinned).toBe(true);
    expect(result.blocks[0].renderBbox).toEqual(before);
    expect(resolveEffectiveRenderBbox(result.blocks[0], source, plain)).toEqual(before);
    expect(result.blocks[0].fontSizePx).toBe(block.fontSizePx);
  });
  it("pins active image lettering to its unexpanded frame without touching its pixels", () => {
    const source = page(), block = source.blocks[0];
    delete block.renderBbox;
    const before = resolveBlockRenderBbox(block, source);
    const result = applyMcpSourceRect(source, request);
    expect(result.blocks[0].renderBbox).toEqual(before);
    expect(result.blocks[0].generatedLettering).toBe(block.generatedLettering);
  });
  it.each([
    { x: -1, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: 0, h: 2 },
    { x: 999, y: 0, w: 2, h: 2 }, { x: 0, y: 1599, w: 2, h: 2 },
    { x: NaN, y: 0, w: 2, h: 2 }, { x: 0, y: 0, w: Infinity, h: 2 },
    { x: 0, y: 0, w: 0.1, h: 2 },
  ])("rejects invalid/unrepresentable bounds without clipping: %j", (sourceRect) => {
    const source = page(), before = structuredClone(source);
    expect(() => applyMcpSourceRect(source, { ...request, sourceRect })).toThrow();
    expect(source).toEqual(before);
  });
  it("accepts page-edge and fractional-pixel coordinates without rounding", () => {
    const source = page();
    for (const sourceRect of [{ x: 0, y: 0, w: 1000, h: 1600 }, { x: 10.25, y: 20.5, w: 35.5, h: 40.25 }]) {
      const result = applyMcpSourceRect(source, { ...request, sourceRect });
      for (const key of ["x", "y", "w", "h"] as const) expect(result.result.sourceRect[key]).toBeCloseTo(sourceRect[key], 8);
    }
  });
  it("refuses missing/ambiguous block IDs and corrupt page dimensions", () => {
    const source = page();
    expect(() => applyMcpSourceRect(source, { ...request, blockId: "missing" })).toThrow("not found");
    source.blocks.push(source.blocks[0]);
    expect(() => applyMcpSourceRect(source, request)).toThrow("duplicate");
    source.width = 0;
    expect(() => applyMcpSourceRect(source, request)).toThrow("dimensions");
  });
  it("validates strict single-block requests before application", () => {
    expect(McpSourceRectPatchSchema.safeParse(request).success).toBe(true);
    for (const extra of [{ force: true }, { blockIds: ["a", "b"] }, { renderRect: request.sourceRect }, { revision: "bad" }]) expect(McpSourceRectPatchSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(McpSourceRectPatchSchema.safeParse({ ...request, sourceRect: { ...request.sourceRect, path: "private" } }).success).toBe(false);
  });
});
