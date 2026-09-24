import { describe, expect, it } from "vitest";
import { editingFixture } from "./mcpEditing.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { createConditionalBatchPreview } from "../src/shared/conditionalBatchEngine";
import { McpBlockPatchSchema } from "../src/shared/mcpBlockEditing";
import { createMcpPageEditTools } from "../src/main/mcp/mcpPageEditTools";
import { invokeMcpTool, describeMcpTool } from "../src/main/mcp/mcpReadTools";
import { mcpToolResult } from "../src/main/mcp/mcpToolResult";
import { McpEditError } from "../src/main/application/mcpEditPolicy";

function fixture() {
  const f = editingFixture();
  const target = {
    chapterId: "chapter",
    pageId: "page",
    revision: f.request.revision,
  };
  return { ...f, target, tools: createMcpPageEditTools(f.service, true, true) };
}
function findTool(f: ReturnType<typeof fixture>, name: string) {
  const tool = f.tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing test tool: ${name}`);
  return tool;
}
describe("targeted MCP block editing", () => {
  it("uses the real formatting engine while preserving source bounds, image data and all unselected blocks", async () => {
    const f = fixture();
    const before = structuredClone(f.chapter.pages[0]);
    const fields = {
      sourceText: "corrected source",
      translatedText: "new text",
      fontSizePx: 34,
      bold: true,
      renderDirection: "vertical" as const,
    };
    const reference = createConditionalBatchPreview(
      f.chapter,
      { kind: "selection", pageId: "page", blockIds: ["a"] },
      {
        name: "parity",
        description: "",
        match: { mode: "allBlocks", conditions: [], groups: [] },
        actions: [
          {
            id: "fields",
            enabled: true,
            type: "setFields",
            changes: [
              {
                field: "sourceText",
                operation: "set",
                value: fields.sourceText,
              },
              {
                field: "translatedText",
                operation: "set",
                value: fields.translatedText,
              },
              {
                field: "fontSizePx",
                operation: "set",
                value: fields.fontSizePx,
              },
              { field: "bold", operation: "set", value: true },
              { field: "renderDirection", operation: "set", value: "vertical" },
            ],
          },
        ],
      },
    );
    const result = await f.service.updateBlocks({
      ...f.target,
      edits: [{ blockId: "a", fields }],
    });
    expect(result.status).toBe("saved");
    expect(result.changedBlockIds).toEqual(["a"]);
    expect(f.chapter.pages[0]).toEqual({
      ...before,
      blocks: [reference.results[0].afterBlock, before.blocks[1]],
    });
    expect(f.chapter.pages[0].blocks[0]).toMatchObject({
      fontSizeIntent: "manual",
      autoFitText: false,
      layoutIntentSuppressed: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|dataUrl/);
    expect(result.warnings).toHaveLength(1);
    expect(result.blocks[0].fields).toMatchObject(fields);
  });
  it("changes only display geometry with app normalization and returns the applied bounds", async () => {
    const f = fixture();
    const before = structuredClone(f.chapter.pages[0]);
    const result = await f.service.updateBlocks({
      ...f.target,
      edits: [{ blockId: "b", renderRect: { x: 200, y: 320, w: 300, h: 160 } }],
    });
    expect(f.chapter.pages[0]).toEqual({
      ...before,
      blocks: [
        before.blocks[0],
        {
          ...before.blocks[1],
          renderBbox: { x: 200, y: 200, w: 300, h: 100 },
          renderBboxSpace: "normalized_1000",
        },
      ],
    });
    expect(result.blocks[0].renderBbox).toEqual({
      x: 200,
      y: 200,
      w: 300,
      h: 100,
    });
    expect(result.revision).toBe(createPageRevision(f.chapter.pages[0]));
  });
  it("supports exact no-op retries but does not overwrite a later manual edit", async () => {
    const f = fixture();
    const request = {
      ...f.target,
      edits: [
        { blockId: "a", fields: { fontSizePx: 36, translatedText: "edited" } },
      ],
    };
    await f.service.updateBlocks(request);
    expect((await f.service.updateBlocks(request)).status).toBe(
      "already_applied",
    );
    expect(f.savePageBlocks).toHaveBeenCalledTimes(1);
    f.chapter.pages[0].blocks[0].translatedText = "manual later";
    await expect(f.service.updateBlocks(request)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.chapter.pages[0].blocks[0].translatedText).toBe("manual later");
  });
  it("validates all selected edits before saving any and rejects duplicate IDs or oversized display areas", async () => {
    const f = fixture();
    for (const edits of [
      [
        { blockId: "a", fields: { translatedText: "ok" } },
        { blockId: "missing", fields: { translatedText: "bad" } },
      ],
      [
        { blockId: "a", fields: { bold: true } },
        { blockId: "a", fields: { bold: false } },
      ],
      [{ blockId: "a", renderRect: { x: 0, y: 0, w: 4001, h: 200 } }],
    ])
      await expect(
        f.service.updateBlocks({ ...f.target, edits }),
      ).rejects.toThrow();
    expect(f.savePageBlocks).not.toHaveBeenCalled();
    expect(f.chapter.pages[0].blocks[0].translatedText).toBe("original-a");
  });
  it("protects dirty pages, concurrent changes and revocation at the same commit boundary as text-only edits", async () => {
    for (const cause of ["dirty", "revision", "revoked"]) {
      const f = fixture();
      let authorized = true;
      if (cause === "dirty")
        f.assertWritable.mockRejectedValueOnce(
          new McpEditError("editor_busy", "dirty"),
        );
      else
        f.assertWritable
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(async () => {
            if (cause === "revision")
              f.chapter.pages[0].blocks[1].translatedText = "concurrent";
            else authorized = false;
          });
      await expect(
        f.service.updateBlocks(
          { ...f.target, edits: [{ blockId: "a", fields: { bold: true } }] },
          () => {
            if (!authorized) throw new McpEditError("access_denied", "revoked");
          },
        ),
      ).rejects.toThrow();
      expect(f.chapter.pages[0].blocks[0].bold).toBeUndefined();
      expect(f.notifySaved).not.toHaveBeenCalled();
    }
  });
  it("rejects unexpected fields, model artifacts and invalid numeric limits before library access", async () => {
    const f = fixture();
    const tool = findTool(f, "carrot_update_page_blocks");
    for (const patch of [
      {},
      { fields: {} },
      { fields: { id: "new-id" } },
      { fields: { fontSizePx: 0 } },
      { fields: { fontSizePx: NaN } },
      { fields: { textColor: "url(secret)" } },
      { fields: { generatedLettering: { dataUrl: "private" } } },
      { sourceRect: { x: 0, y: 0, w: 10, h: 20 } },
      { renderRect: { x: 0.5, y: 0, w: 1, h: 2 } },
    ])
      await expect(
        invokeMcpTool(tool, {
          ...f.target,
          edits: [{ blockId: "a", ...patch }],
        }),
      ).rejects.toThrow();
    expect(f.openChapter).not.toHaveBeenCalled();
    expect(
      McpBlockPatchSchema.safeParse({
        ...f.target,
        edits: Array(101).fill({ blockId: "a", fields: { bold: true } }),
      }).success,
    ).toBe(false);
  });
  it("provides schema-validated structured results and requires both feature approvals", async () => {
    const f = fixture();
    for (const [edit, process] of [
      [false, false],
      [true, false],
      [false, true],
    ])
      expect(
        createMcpPageEditTools(f.service, edit, process).some(
          (t) => t.name === "carrot_update_page_blocks",
        ),
      ).toBe(false);
    const tool = findTool(f, "carrot_update_page_blocks");
    expect(describeMcpTool(tool).securitySchemes?.[0].scopes).toEqual([
      "carrot.read",
      "carrot.edit",
      "carrot.process",
    ]);
    const content = await invokeMcpTool(tool, {
      ...f.target,
      edits: [
        {
          blockId: "b",
          fields: { reviewNote: "checked", inpaintExcluded: true },
        },
      ],
    });
    expect(mcpToolResult(tool, content)).toMatchObject({
      isError: false,
      structuredContent: { status: "saved", changedBlockIds: ["b"] },
    });
    const read = await f.service.read("chapter", "page", {
      offset: 0,
      limit: 100,
    });
    expect(read.effectiveBlockOrder).toEqual(["b", "a"]);
    expect(read.blocks[1].fields.reviewNote).toBe("checked");
  });
});
describe("independent reading order", () => {
  it("changes explicit ordering only and can restore the previous order using the new revision", async () => {
    const f = fixture();
    const before = structuredClone(f.chapter.pages[0]);
    const result = await f.service.reorder({
      ...f.target,
      blockIds: ["a", "b"],
    });
    expect(result).toMatchObject({
      status: "saved",
      changed: true,
      previousBlockOrder: ["b", "a"],
      blockOrder: ["a", "b"],
    });
    expect(f.chapter.pages[0]).toEqual({ ...before, blockOrder: ["a", "b"] });
    expect(
      (await f.service.reorder({ ...f.target, blockIds: ["a", "b"] })).status,
    ).toBe("already_applied");
    const restored = await f.service.reorder({
      ...f.target,
      revision: result.revision,
      blockIds: result.previousBlockOrder,
    });
    expect(restored.status).toBe("saved");
    expect(f.chapter.pages[0]).toEqual(before);
  });
  it.each(
    [["a"], ["a", "a"], ["a", "missing"], []].map((blockIds) => ({ blockIds })),
  )(
    "rejects incomplete or duplicate orders $blockIds",
    async ({ blockIds }) => {
      const f = fixture();
      await expect(
        f.service.reorder({ ...f.target, blockIds }),
      ).rejects.toMatchObject({ code: "invalid_edit" });
      expect(f.savePageBlocks).not.toHaveBeenCalled();
    },
  );
  it("permits an empty page no-op, validates transport arguments and returns a structured order", async () => {
    const f = fixture();
    const tool = findTool(f, "carrot_set_page_reading_order");
    await expect(
      invokeMcpTool(tool, { ...f.target, blockIds: ["a", "b"], force: true }),
    ).rejects.toThrow();
    const result = await invokeMcpTool(tool, {
      ...f.target,
      blockIds: ["a", "b"],
    });
    expect(mcpToolResult(tool, result).isError).toBe(false);
    f.chapter.pages[0].blocks = [];
    f.chapter.pages[0].blockOrder = [];
    expect(
      (await f.service.reorder({ ...f.target, blockIds: [] })).status,
    ).toBe("already_applied");
  });
});
