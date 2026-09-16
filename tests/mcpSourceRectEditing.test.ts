import { describe, expect, it, vi } from "vitest";
import { editingFixture } from "./mcpEditing.fixture";
import { McpPageEditService } from "../src/main/application/mcpPageEditService";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import { createMcpPageEditTools } from "../src/main/mcp/mcpPageEditTools";
import { describeMcpTool, invokeMcpTool } from "../src/main/mcp/mcpReadTools";
import { McpSourceRectResultSchema } from "../src/shared/mcpSourceRect";
import { createPageRevision } from "../src/shared/pageRevision";

const name = "carrot_update_block_source_rect";
function fixture() {
  const f = editingFixture();
  const request = {
    chapterId: "chapter",
    pageId: "page",
    blockId: "a",
    revision: f.request.revision,
    sourceRect: { x: 100.25, y: 200.5, w: 250.5, h: 160.25 },
  };
  const tool = createMcpPageEditTools(f.service, true, true).find(
    (item) => item.name === name,
  );
  if (!tool) throw new Error("Source rectangle tool is not registered");
  return { ...f, request, tool };
}

describe("single-block source rectangle mutation", () => {
  it("saves only selected geometry through the existing transaction and returns metadata", async () => {
    const f = fixture();
    const before = structuredClone(f.chapter.pages[0]);
    const content = await invokeMcpTool(f.tool, f.request);
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    if (content[0].type !== "text") throw new Error("Expected metadata");
    const result = McpSourceRectResultSchema.parse(JSON.parse(content[0].text));
    expect(result).toMatchObject({ status: "saved", changed: true });
    expect(result.sourceRect).toEqual(f.request.sourceRect);
    expect(result.revision).toBe(createPageRevision(f.chapter.pages[0]));
    expect(f.chapter.pages[0]).toEqual({
      ...before,
      blocks: [
        { ...before.blocks[0], bbox: result.sourceBbox, bboxSpace: "normalized_1000" },
        before.blocks[1],
      ],
    });
    expect(f.notifySaved).toHaveBeenCalledOnce();
    expect(f.savePageBlocks.mock.calls[0][0]).toMatchObject({
      expectedRevision: f.request.revision,
      saveReason: "manual",
      blockOrder: before.blockOrder,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|PRIVATE|dataUrl|sourceText|resource_link/);
  });

  it("requires a fresh revision even for retries and unchanged bounds", async () => {
    const f = fixture();
    const saved = await f.service.updateSourceRect(f.request);
    await expect(f.service.updateSourceRect(f.request)).rejects.toMatchObject({ code: "revision_conflict" });
    const noOp = await f.service.updateSourceRect({ ...f.request, revision: saved.revision });
    expect(noOp).toMatchObject({ status: "already_applied", changed: false, warnings: [] });
    expect(f.savePageBlocks).toHaveBeenCalledOnce();
    const restored = await f.service.updateSourceRect({ ...f.request, revision: saved.revision, sourceRect: saved.previousSourceRect });
    expect(restored.status).toBe("saved");
    expect(restored.sourceRect).toEqual(saved.previousSourceRect);
  });

  it.each(["dirty", "running", "missing", "revision", "revoked"])(
    "does not save when the page is %s",
    async (cause) => {
      const f = fixture();
      if (cause === "dirty") f.assertWritable.mockRejectedValueOnce(new McpEditError("editor_busy", "dirty"));
      if (cause === "running") f.chapter.pages[0].analysisStatus = "running";
      if (cause === "missing") f.request.pageId = "missing";
      if (cause === "revision") f.chapter.pages[0].blocks[1].translatedText = "later edit";
      const before = structuredClone(f.chapter);
      await expect(f.service.updateSourceRect(f.request, () => {
        if (cause === "revoked") throw new McpEditError("access_denied", "revoked");
      })).rejects.toThrow();
      expect(f.chapter).toEqual(before);
      expect(f.savePageBlocks).not.toHaveBeenCalled();
      expect(f.notifySaved).not.toHaveBeenCalled();
    },
  );

  it("waits for page ownership and uses the lease authorization at commit", async () => {
    const f = fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const leaseGuard = vi.fn();
    const service = new McpPageEditService({
      ...f,
      withPageEdit: async (target, authorize, execute) => {
        expect(target.pageId).toBe("page");
        authorize();
        entered();
        await pending;
        return execute(leaseGuard);
      },
    });
    const result = service.updateSourceRect(f.request);
    await started;
    expect(f.openChapter).not.toHaveBeenCalled();
    expect(f.savePageBlocks).not.toHaveBeenCalled();
    release();
    await result;
    expect(leaseGuard).toHaveBeenCalled();
    expect(f.savePageBlocks.mock.calls[0][1]).toBe(leaseGuard);
  });

  it("rechecks concurrent saves and revocation before committing", async () => {
    for (const conflict of [true, false]) {
      const f = fixture();
      let authorized = true;
      f.assertWritable.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
        if (conflict) f.chapter.pages[0].blocks[1].translatedText = "concurrent";
        else authorized = false;
      });
      const before = structuredClone(f.chapter.pages[0].blocks[0]);
      await expect(f.service.updateSourceRect(f.request, () => {
        if (!authorized) throw new McpEditError("access_denied", "revoked");
      })).rejects.toMatchObject({ code: conflict ? "revision_conflict" : "access_denied" });
      expect(f.chapter.pages[0].blocks[0]).toEqual(before);
      expect(f.notifySaved).not.toHaveBeenCalled();
    }
  });

  it("rejects extra fields and nonrectangles before reading the library", async () => {
    const f = fixture();
    for (const args of [
      { ...f.request, force: true },
      { ...f.request, blockId: "../secret" },
      { ...f.request, sourceRect: { ...f.request.sourceRect, path: "private" } },
      { ...f.request, sourceRect: [1, 2, 3, 4] },
      { ...f.request, sourceRect: { x: 0, y: 0, w: 0, h: 2 } },
    ]) await expect(invokeMcpTool(f.tool, args)).rejects.toThrow();
    expect(f.openChapter).not.toHaveBeenCalled();
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });

  it("requires editing and processing approvals, without requesting image access", () => {
    const f = fixture();
    for (const [edit, process] of [[false, false], [true, false], [false, true]]) {
      expect(createMcpPageEditTools(f.service, edit, process).some((tool) => tool.name === name)).toBe(false);
    }
    expect(describeMcpTool(f.tool).securitySchemes?.[0].scopes).toEqual([
      "carrot.read", "carrot.edit", "carrot.process",
    ]);
  });
});
