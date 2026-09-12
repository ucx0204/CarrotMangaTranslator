import { describe, it, expect, vi } from "vitest";
import { editingChapter } from "./mcpEditing.fixture";
import { McpPageImageService } from "../src/main/application/mcpPageImageService";
import { createMcpPageImageTools } from "../src/main/mcp/mcpPageImageTools";
import { invokeMcpTool } from "../src/main/mcp/mcpReadTools";
import { createPageRevision } from "../src/shared/pageRevision";

function fixture() {
  const chapter = editingChapter();
  const image = { data: "APPROVED_PNG", width: 200, height: 100 };
  const crop = vi.fn(async () => image);
  const render = vi.fn(async () => image);
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const service = new McpPageImageService({ openChapter, crop, render });
  return {
    chapter,
    service,
    crop,
    render,
    tools: createMcpPageImageTools(service),
  };
}
describe("independent MCP page images", () => {
  it("renders current saved blocks without running crop/OCR/edit paths or leaking artifacts", async () => {
    const f = fixture();
    const content = await invokeMcpTool(f.tools[0], {
      chapterId: "chapter",
      pageId: "page",
    });
    expect(f.render).toHaveBeenCalledWith(f.chapter.pages[0]);
    expect(f.crop).not.toHaveBeenCalled();
    expect(content[1]).toEqual({
      type: "image",
      data: "APPROVED_PNG",
      mimeType: "image/png",
    });
    expect(JSON.stringify(content)).not.toMatch(/private|PRIVATE/);
    const metadata = JSON.parse(
      content[0].type === "text" ? content[0].text : "null",
    );
    expect(metadata.kind).toBe("rendered-page");
    expect(metadata.revision).toBe(createPageRevision(f.chapter.pages[0]));
    expect(
      f.tools.every((t) => t.requiredScopes?.includes("carrot.images")),
    ).toBe(true);
  });
  it("maps resized crop pixels back to original pixels explicitly", async () => {
    const f = fixture();
    const rect = { x: 200, y: 300, w: 400, h: 200 };
    const result = await f.service.read("chapter", "page", rect);
    expect(result.pixelMapping).toEqual({
      originX: 200,
      originY: 300,
      scaleX: 2,
      scaleY: 2,
    });
    expect(result.kind).toBe("source-crop");
    expect(f.crop).toHaveBeenCalledWith(f.chapter.pages[0], rect);
    expect(f.render).not.toHaveBeenCalled();
  });
  it.each([
    { x: -1, y: 0, w: 1, h: 1 },
    { x: 999, y: 0, w: 2, h: 1 },
    { x: 0, y: 1599, w: 1, h: 2 },
    { x: 0, y: 0, w: 0, h: 1 },
    { x: 0.5, y: 0, w: 1, h: 1 },
    { x: NaN, y: 0, w: 1, h: 1 },
  ])("rejects invalid pixel rectangle before image work: %j", async (rect) => {
    const f = fixture();
    await expect(
      invokeMcpTool(f.tools[1], { chapterId: "chapter", pageId: "page", rect }),
    ).rejects.toThrow();
    expect(f.crop).not.toHaveBeenCalled();
  });
  it("rejects injected paths/unknown arguments and absent pages", async () => {
    const f = fixture();
    await expect(
      invokeMcpTool(f.tools[0], {
        chapterId: "chapter",
        pageId: "page",
        path: "/private",
      }),
    ).rejects.toThrow();
    await expect(
      invokeMcpTool(f.tools[1], {
        chapterId: "chapter",
        pageId: "page",
        rect: { x: 0, y: 0, w: 1, h: 1, path: "/private" },
      }),
    ).rejects.toThrow();
    await expect(f.service.read("chapter", "missing")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(f.render).not.toHaveBeenCalled();
  });
  it("does not return stale rendered content or use a fallback after a failure", async () => {
    const f = fixture();
    f.render.mockImplementationOnce(async () => {
      f.chapter.pages[0].blocks[0].translatedText = "local update";
      return { data: "STALE", width: 1, height: 1 };
    });
    await expect(f.service.read("chapter", "page")).rejects.toMatchObject({
      code: "revision_conflict",
    });
    f.render.mockRejectedValueOnce(new Error("redaction"));
    await expect(f.service.read("chapter", "page")).rejects.toThrow(
      "redaction",
    );
    expect(f.crop).not.toHaveBeenCalled();
  });
});
