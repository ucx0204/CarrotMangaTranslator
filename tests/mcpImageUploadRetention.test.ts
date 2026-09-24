import { createHash, randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { McpImageUploadStore } from "../src/main/mcp/mcpImageUploadStore";

it("retains only validation metadata rather than decoded image pixels in the upload cache", async () => {
  const store = new McpImageUploadStore();
  const png = new PNG({ width: 3, height: 2 });
  const bytes = PNG.sync.write(png);
  const guard = () => {};
  try {
    const started = await store.begin(
      "owner",
      {
        chapterId: "chapter",
        pageId: "page",
        revision: "page-v1:0000000000000000",
        contextRevision: "0".repeat(16),
        requestId: randomUUID(),
        purpose: "image",
        mimeType: "image/png",
        width: 3,
        height: 2,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      [],
      guard,
    );
    await store.chunk(
      "owner",
      { uploadId: started.uploadId, offset: 0, data: bytes.toString("base64") },
      guard,
    );
    await store.finish("owner", started.uploadId, guard);
    // Resource-retention invariant: inspect actual cached state, not source text,
    // decoder mocks or nondeterministic garbage-collection timing.
    const entries: Map<string, { ready: unknown }> = Reflect.get(
      store,
      "entries",
    );
    expect(entries.get(started.uploadId)?.ready).toEqual({
      hasTransparency: true,
      selectedPixels: null,
    });
    await store.use("owner", started.uploadId, guard, async (asset) => {
      expect(asset.bytes).toEqual(bytes);
    });
  } finally {
    await store.close();
  }
});
