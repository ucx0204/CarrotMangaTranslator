import { createHash, randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { vi } from "vitest";
import { imageEditingFixture } from "./mcpImageEditing.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { McpImageUploadBeginSchema, mcpImageUploadOutputs, MCP_UPLOAD_CHUNK_BYTES } from "../src/shared/mcpImageUploads";
import { McpExternalImagePreviewSchema, mcpExternalImageOutputs, type McpExternalImagePreview } from "../src/shared/mcpExternalImages";

export async function externalImageFixture() {
  const f = await imageEditingFixture();
  const { createMcpExternalImageSession } = await import("../src/main/mcp/mcpExternalImageSession");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const external = createMcpExternalImageSession(f.app, f.editing, true, true);
  const invoke = async (name: string, args: object, caller = f.auth()) => {
    const tool = external.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Missing external tool ${name}`);
    return mcpToolResult(tool, await tool.invoke(args as Record<string, unknown>, caller));
  };
  const binding = async () => {
    const saved = await f.library.readWorkContextForEdit("chapter");
    return { chapterId: "chapter", pageId: "page", revision: createPageRevision(saved.chapter.pages[0]), contextRevision: mcpContextRevision(saved) };
  };
  const upload = async (png: PNG, purpose: "image" | "mask" = "image") => {
    const bytes = PNG.sync.write(png);
    const input = McpImageUploadBeginSchema.parse({ ...await binding(), requestId: randomUUID(), purpose,
      mimeType: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: png.width, height: png.height });
    const receipt = mcpImageUploadOutputs.carrot_begin_image_upload.parse((await invoke("carrot_begin_image_upload", input)).structuredContent);
    for (let offset = 0; offset < bytes.length; offset += MCP_UPLOAD_CHUNK_BYTES)
      await invoke("carrot_write_image_upload", { uploadId: receipt.uploadId, offset, data: bytes.subarray(offset, offset + MCP_UPLOAD_CHUNK_BYTES).toString("base64") });
    const ready = mcpImageUploadOutputs.carrot_finish_image_upload.parse((await invoke("carrot_finish_image_upload", { uploadId: receipt.uploadId })).structuredContent);
    return { ...ready, input, bytes };
  };
  const preview = async (command: McpExternalImagePreview["command"]) => {
    const request = McpExternalImagePreviewSchema.parse({ ...await binding(), requestId: randomUUID(), reason: "Isolated external asset", command });
    const reply = await invoke("carrot_preview_external_image", request);
    return { request, ...mcpExternalImageOutputs.carrot_preview_external_image.parse(reply.structuredContent) };
  };
  const inspect = async (batchId: string) => mcpExternalImageOutputs.carrot_get_external_image.parse((await invoke("carrot_get_external_image", { batchId })).structuredContent);
  const action = async (batchId: string, direction: string, requestId = randomUUID()) => {
    const receipt = await invoke(`carrot_${direction}_external_image`, { batchId, requestId });
    await vi.waitFor(async () => {
      if ((await inspect(batchId)).status === "running") throw new Error("External action is running");
    }, { timeout: 10000 });
    return { receipt, result: await inspect(batchId) };
  };
  return { ...f, external, invoke, binding, upload, preview, inspect, action,
    close: async () => { await external.close(); await f.close(); } };
}
export function externalPng(width = 8, height = 6, mask = false) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    if (mask) png.data.fill(255, i, i + 4);
    else { png.data[i] = 19; png.data[i + 1] = 70; png.data[i + 2] = 121; png.data[i + 3] = i % 12 ? 255 : 90; }
  }
  return png;
}
