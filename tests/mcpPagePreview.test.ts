import assert from "node:assert/strict";
import { it } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { McpPagePreviewService } from "../src/main/application/mcpPagePreviewService";
import { createMcpPagePreviewTool } from "../src/main/mcp/mcpPagePreviewTool";
import { invokeMcpTool } from "../src/main/mcp/mcpReadTools";
import { handleMcpMessage } from "../src/main/mcp/mcpProtocol";

function chapter(): ChapterSnapshot {
  return {
    id: "chapter",
    workId: "work",
    title: "Chapter",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page"],
    createdAt: "now",
    updatedAt: "now",
    pages: [
      {
        id: "page",
        name: "page.png",
        width: 2000,
        height: 4000,
        imagePath: "/private/original.png",
        dataUrl: "PRIVATE DATA URL",
        blocks: [],
        analysisStatus: "idle",
        createdAt: "now",
        updatedAt: "revision",
      },
    ],
  };
}

function previewService(
  renderApprovedPreview: ConstructorParameters<
    typeof McpPagePreviewService
  >[0]["renderApprovedPreview"],
) {
  return new McpPagePreviewService({
    openChapter: async (id) => {
      assert.equal(id, "chapter");
      return chapter();
    },
    renderApprovedPreview,
  });
}

it("returns only approved image bytes and source/preview dimensions", async () => {
  let seenPath = "";
  const service = previewService(async (page) => {
    seenPath = page.imagePath;
    return { data: "APPROVED", width: 800, height: 1600 };
  });
  const content = await invokeMcpTool(createMcpPagePreviewTool(service), {
    chapterId: "chapter",
    pageId: "page",
  });
  assert.equal(seenPath, "/private/original.png");
  assert.equal(content[0].type, "text");
  assert.deepEqual(content[1], {
    type: "image",
    data: "APPROVED",
    mimeType: "image/png",
  });
  const encoded = JSON.stringify(content);
  assert.ok(encoded.includes("sourceWidth"));
  assert.ok(encoded.includes("previewWidth"));
  assert.equal(encoded.includes("/private"), false);
  assert.equal(encoded.includes("PRIVATE DATA URL"), false);
});

it("never renders an image when pageId is not in the selected chapter", async () => {
  let renders = 0;
  const service = previewService(async () => {
    renders++;
    return { data: "PNG", width: 1, height: 1 };
  });
  await assert.rejects(service.getPreview("chapter", "wrong-page"));
  assert.equal(renders, 0);
});

it("propagates the approval failure without returning unapproved fallback bytes", async () => {
  const failure = new Error("review required for /private/original.png");
  const service = previewService(async () => {
    throw failure;
  });
  await assert.rejects(
    service.getPreview("chapter", "page"),
    (error) => error === failure,
  );
  const errors: unknown[] = [];
  const reply = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "carrot_get_page_preview",
        arguments: { chapterId: "chapter", pageId: "page" },
      },
    },
    [createMcpPagePreviewTool(service)],
    (error) => errors.push(error),
  );
  const serialized = JSON.stringify(reply.body);
  assert.ok(serialized.includes('"isError":true'));
  assert.equal(serialized.includes('"type":"image"'), false);
  assert.equal(serialized.includes("/private"), false);
  assert.deepEqual(errors, [failure]);
});

it("rejects caller-supplied paths and identifiers before reaching the preview port", async () => {
  let renders = 0;
  const tool = createMcpPagePreviewTool(
    previewService(async () => {
      renders++;
      return { data: "PNG", width: 1, height: 1 };
    }),
  );
  for (const args of [
    { chapterId: "chapter", pageId: "../private" },
    { chapterId: "chapter", pageId: "page", path: "/etc/passwd" },
    { chapterId: "chapter" },
    null,
  ]) {
    await assert.rejects(invokeMcpTool(tool, args));
  }
  assert.equal(renders, 0);
});
