import { describe, it, expect, vi } from "vitest";
import { editingFixture } from "./mcpEditing.fixture";
import { McpReadingService } from "../src/main/application/mcpReadingService";
import { createMcpReadingTool } from "../src/main/mcp/mcpReadingTool";
import { invokeMcpTool } from "../src/main/mcp/mcpReadTools";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import { createPageRevision } from "../src/shared/pageRevision";

function fixture() {
  const f = editingFixture();
  const defaults = vi.fn(async () => ({
    ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
    autoFitText: false,
    fontSizePx: 32,
    fontFamily: "test-font",
  }));
  const service = new McpReadingService({ ...f, defaults });
  const request = {
    chapterId: "chapter",
    pageId: "page",
    revision: f.request.revision,
    requestId: "00000000-0000-4000-a000-000000000001",
    blocks: [
      {
        key: "first",
        sourceText: "原文",
        translatedText: "번역문",
        sourceRect: { x: 200, y: 320, w: 100, h: 160 },
        renderRect: { x: 200, y: 320, w: 200, h: 160 },
      },
    ],
  };
  return {
    ...f,
    defaults,
    service,
    request,
    tool: createMcpReadingTool(service),
  };
}
describe("external readings", () => {
  it("appends actual editable app blocks in input order without modifying original images, blocks, masks or order", async () => {
    const f = fixture();
    const before = structuredClone(f.chapter.pages[0]);
    const result = await f.service.create(f.request);
    expect(result.status).toBe("saved");
    const page = f.chapter.pages[0];
    expect(page.blocks.slice(0, 2)).toEqual(before.blocks);
    expect(page.blockOrder).toEqual(["b", "a", ...result.blockIds]);
    expect({
      ...page,
      blocks: before.blocks,
      blockOrder: before.blockOrder,
    }).toEqual(before);
    expect(page.blocks[2]).toMatchObject({
      sourceText: "原文",
      translatedText: "번역문",
      bbox: { x: 200, y: 200, w: 100, h: 100 },
      renderBbox: { x: 200, y: 200, w: 200, h: 100 },
      fontFamily: "test-font",
      fontSizePx: 32,
    });
    expect(result.revision).toBe(createPageRevision(page));
    expect(f.notifySaved).toHaveBeenCalledWith("chapter", "page");
  });
  it("exact retries keep stable IDs after recreation and do not duplicate blocks", async () => {
    const f = fixture();
    const first = await f.service.create(f.request);
    f.defaults.mockResolvedValueOnce({
      ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
      autoFitText: true,
      fontSizePx: 10,
      fontFamily: "changed",
    });
    const service = new McpReadingService(f);
    const second = await service.create(f.request);
    expect(second).toEqual({ ...first, status: "already_applied" });
    expect(f.savePageBlocks).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite a later manual edit when the caller reuses an old request", async () => {
    const f = fixture();
    await f.service.create(f.request);
    f.chapter.pages[0].blocks[2].translatedText = "manual";
    await expect(f.service.create(f.request)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.savePageBlocks).toHaveBeenCalledTimes(1);
  });
  it("rejects a retry whose saved render direction was manually changed", async () => {
    const f = fixture();
    await f.service.create(f.request);
    f.chapter.pages[0].blocks[2].renderDirection = "vertical";
    await expect(f.service.create(f.request)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.savePageBlocks).toHaveBeenCalledTimes(1);
    expect(f.chapter.pages[0].blocks[2].renderDirection).toBe("vertical");
  });
  it("refuses duplicate keys, partial retries, out-of-bounds regions and stale revisions", async () => {
    const f = fixture();
    await expect(
      f.service.create({
        ...f.request,
        blocks: [...f.request.blocks, ...f.request.blocks],
      }),
    ).rejects.toThrow();
    await expect(
      f.service.create({
        ...f.request,
        blocks: [
          {
            ...f.request.blocks[0],
            sourceRect: { x: 990, y: 0, w: 20, h: 20 },
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      f.service.create({ ...f.request, revision: "page-v1:ffffffffffffffff" }),
    ).rejects.toThrow();
    expect(f.savePageBlocks).not.toHaveBeenCalled();
    await f.service.create(f.request);
    await expect(
      f.service.create({
        ...f.request,
        blocks: [
          ...f.request.blocks,
          { ...f.request.blocks[0], key: "second" },
        ],
      }),
    ).rejects.toThrow();
  });
  it("supports a blank source page and OCR-only submissions with empty translations", async () => {
    const f = fixture();
    f.chapter.pages[0].blocks = [];
    f.chapter.pages[0].blockOrder = [];
    f.request.revision = createPageRevision(f.chapter.pages[0]);
    f.request.blocks[0].translatedText = "";
    await f.service.create(f.request);
    expect(f.chapter.pages[0].blocks).toHaveLength(1);
    expect(f.chapter.pages[0].blocks[0].translatedText).toBe("");
  });
  it("rejects schema injection and requires a processing grant", async () => {
    const f = fixture();
    for (const args of [
      { ...f.request, path: "/private" },
      { ...f.request, requestId: "reuse-anything" },
      {
        ...f.request,
        blocks: [
          { ...f.request.blocks[0], generatedLettering: { dataUrl: "bad" } },
        ],
      },
      {
        ...f.request,
        blocks: [
          {
            ...f.request.blocks[0],
            sourceRect: { x: 1.5, y: 0, w: 10, h: 10 },
          },
        ],
      },
      { ...f.request, chapterId: "../../private" },
    ])
      await expect(invokeMcpTool(f.tool, args)).rejects.toThrow();
    expect(f.savePageBlocks).not.toHaveBeenCalled();
    expect(f.tool.requiredScopes).toContain("carrot.process");
  });
  it("passes authorization into the actual commit boundary and refuses permission changes", async () => {
    const f = fixture();
    const deny = vi.fn(() => {
      throw new Error("revoked");
    });
    await expect(f.service.create(f.request, deny)).rejects.toThrow("revoked");
    expect(f.savePageBlocks).not.toHaveBeenCalled();
    const auth = vi.fn();
    await f.service.create(f.request, auth);
    expect(f.savePageBlocks.mock.calls[0][1]).toBe(auth);
  });
});
