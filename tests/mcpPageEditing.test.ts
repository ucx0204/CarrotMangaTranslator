import { describe, expect, it } from "vitest";
import { createPageRevision } from "../src/shared/pageRevision";
import { hashTranslationBlocks } from "../src/shared/blockFingerprint";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import { createMcpPageEditTools } from "../src/main/mcp/mcpPageEditTools";
import { createMcpToolSet } from "../src/main/mcp/mcpToolSet";
import { describeMcpTool, invokeMcpTool } from "../src/main/mcp/mcpReadTools";
import { handleMcpMessage } from "../src/main/mcp/mcpProtocol";
import { editingFixture } from "./mcpEditing.fixture";

describe("MCP existing translation editing", () => {
  it("pages through safe block fields without exporting image artifacts or paths", async () => {
    const f = editingFixture();
    const first = await f.service.read("chapter", "page", {
      offset: 0,
      limit: 1,
    });
    expect(first.blocks.map((b) => b.id)).toEqual(["a"]);
    expect(first.nextOffset).toBe(1);
    expect(first.revision).toBe(f.request.revision);
    const last = await f.service.read("chapter", "page", {
      offset: 1,
      limit: 1,
    });
    expect(last.nextOffset).toBeNull();
    expect(last.blocks[0].hasGeneratedLettering).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE|\/private|dataUrl/);
    expect(f.assertWritable).not.toHaveBeenCalled();
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });
  it("changes only translatedText and retains original geometry, lettering, masks and order", async () => {
    const f = editingFixture();
    const before = structuredClone(f.chapter.pages[0]);
    const result = await f.service.update(f.request);
    expect(result.status).toBe("saved");
    expect(result.changed).toBe(1);
    expect(result.previousTranslations).toEqual([
      { blockId: "a", translatedText: "original-a" },
    ]);
    const expected = structuredClone(before);
    expected.blocks[0].translatedText = "수정한 대사";
    expect(f.chapter.pages[0]).toEqual(expected);
    expect(f.savePageBlocks).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: f.request.revision,
        baseUpdatedAt: before.updatedAt,
        baseBlocksHash: hashTranslationBlocks(before.blocks),
        blockOrder: before.blockOrder,
      }),
    );
    expect(result.revision).toBe(createPageRevision(expected));
    expect(f.notifySaved).toHaveBeenCalledWith("chapter", "page");
  });
  it("makes retries of an already applied absolute text set a no-op", async () => {
    const f = editingFixture();
    await f.service.update(f.request);
    const replay = await f.service.update(f.request);
    expect(replay.status).toBe("already_applied");
    expect(f.savePageBlocks).toHaveBeenCalledTimes(1);
    expect(f.notifySaved).toHaveBeenCalledTimes(1);
  });
  it("restores previous text only with the current revision, not an unconditional undo", async () => {
    const f = editingFixture();
    const result = await f.service.update(f.request);
    const undo = {
      ...f.request,
      revision: result.revision,
      edits: result.previousTranslations,
    };
    const restored = await f.service.update(undo);
    expect(restored.status).toBe("saved");
    expect(f.chapter.pages[0].blocks[0].translatedText).toBe("original-a");
  });
  it("rejects same-timestamp edits and unrelated mask changes using the existing full revision", async () => {
    for (const change of ["text", "mask"]) {
      const f = editingFixture();
      if (change === "text")
        f.chapter.pages[0].blocks[1].translatedText = "local edit";
      else f.chapter.pages[0].inpaintMaskPath = "/private/new-mask.png";
      await expect(f.service.update(f.request)).rejects.toMatchObject({
        code: "revision_conflict",
      });
      expect(f.savePageBlocks).not.toHaveBeenCalled();
    }
  });
  it("blocks dirty local edits and running analysis without starting any save", async () => {
    const f = editingFixture();
    f.assertWritable.mockRejectedValueOnce(
      new McpEditError("editor_busy", "dirty"),
    );
    await expect(f.service.update(f.request)).rejects.toMatchObject({
      code: "editor_busy",
    });
    f.chapter.pages[0].analysisStatus = "running";
    await expect(f.service.update(f.request)).rejects.toMatchObject({
      code: "editor_busy",
    });
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });
  it("rechecks local state and authorization immediately before entering the app save", async () => {
    const f = editingFixture();
    let revoked = false;
    f.assertWritable
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        revoked = true;
      });
    await expect(
      f.service.update(f.request, () => {
        if (revoked) throw new McpEditError("access_denied", "revoked");
      }),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });
  it("lets the real save boundary reject a concurrent change after the initial read", async () => {
    const f = editingFixture();
    f.assertWritable
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        f.chapter.pages[0].blocks[1].translatedText = "winning local edit";
      });
    await expect(f.service.update(f.request)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(f.chapter.pages[0].blocks[0].translatedText).toBe("original-a");
    expect(f.notifySaved).not.toHaveBeenCalled();
  });
  it("rejects unknown and duplicate block identifiers before saving", async () => {
    const f = editingFixture();
    await expect(
      f.service.update({
        ...f.request,
        edits: [{ blockId: "unknown", translatedText: "x" }],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.service.update({
        ...f.request,
        edits: [f.request.edits[0], f.request.edits[0]],
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    expect(f.savePageBlocks).not.toHaveBeenCalled();
  });
  it("does not hide I/O failure as successful save or expose its path in the MCP response", async () => {
    const f = editingFixture();
    const error = new Error("disk unavailable /private/page.json");
    f.savePageBlocks.mockRejectedValueOnce(error);
    const failures: unknown[] = [];
    const result = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "carrot_update_translations", arguments: f.request },
      },
      createMcpPageEditTools(f.service, true),
      (e) => failures.push(e),
    );
    expect(JSON.stringify(result)).toContain('"isError":true');
    expect(JSON.stringify(result)).not.toMatch(/\/private|disk unavailable/);
    expect(failures).toEqual([error]);
    expect(f.notifySaved).not.toHaveBeenCalled();
  });
});

it("advertises only the enabled tools with truthful write scopes and metadata", async () => {
  for (const allowEditing of [false, true]) {
    const f = editingFixture();
    const tools = createMcpToolSet(
      {
        openChapter: f.openChapter,
        listLibrary: async () => ({ works: [], workOrder: [] }),
      },
      undefined,
      true,
      { service: f.service, allowEditing },
    );
    expect(tools.some((t) => t.name === "carrot_update_translations")).toBe(
      allowEditing,
    );
    const capabilities = await invokeMcpTool(tools[0], {});
    expect(JSON.stringify(capabilities)).toContain(
      allowEditing ? "translation-edit" : "read-only",
    );
    for (const tool of tools.filter(
      (t) => t.name === "carrot_update_translations",
    )) {
      const descriptor = describeMcpTool(tool);
      expect(descriptor.annotations.readOnlyHint).toBe(false);
      expect(descriptor.securitySchemes?.[0].scopes).toEqual([
        "carrot.read",
        "carrot.edit",
      ]);
    }
  }
});
it("rejects malformed or excessive edit arguments before any library interaction", async () => {
  const f = editingFixture();
  const tool = createMcpPageEditTools(f.service, true)[1];
  const invalid = [
    { ...f.request, path: "/etc/passwd" },
    { ...f.request, pageId: "../page" },
    { ...f.request, edits: [] },
    { ...f.request, edits: Array(101).fill(f.request.edits[0]) },
    {
      ...f.request,
      edits: [{ ...f.request.edits[0], translatedText: "x".repeat(8193) }],
    },
    {
      ...f.request,
      edits: [{ ...f.request.edits[0], bbox: { x: 0, y: 0, w: 1, h: 1 } }],
    },
    { ...f.request, revision: "wrong" },
  ];
  for (const input of invalid)
    await expect(invokeMcpTool(tool, input)).rejects.toThrow();
  expect(f.openChapter).not.toHaveBeenCalled();
  expect(f.savePageBlocks).not.toHaveBeenCalled();
});
