import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { vi } from "vitest";
import type { McpTool } from "../src/main/mcp/mcpReadTools";
import { createPageRevision } from "../src/shared/pageRevision";
import { compositeNativeSourcesFixture } from "./mcpCompositeNativeSources.fixture";

/** Real saved source bytes and native metadata contract; the renderer boundary is deterministic. */
export async function compositeNativeReviewFixture(
  now: () => number = Date.now,
) {
  const f = await compositeNativeSourcesFixture();
  const { McpCompositeNativeReview } =
    await import("../src/main/mcp/mcpCompositeNativeReview");
  const { setImageRedactionEnabled } =
    await import("../src/main/imageRedactionStore");
  const render = vi.fn<McpTool["invoke"]>(async (args) => {
    const saved = await f.library.openChapter(String(args.chapterId));
    const page = saved.pages.find((value) => value.id === args.pageId);
    if (!page) throw new Error("Missing native preview page");
    const bytes = await readFile(page.imagePath);
    const png = PNG.sync.read(bytes);
    return [
      {
        type: "text",
        text: JSON.stringify({
          chapterId: saved.id,
          pageId: page.id,
          revision: createPageRevision(page),
          kind: "rendered-page",
          sourceWidth: page.width,
          sourceHeight: page.height,
          width: png.width,
          height: png.height,
          crop: null,
          pixelMapping: {
            originX: 0,
            originY: 0,
            scaleX: page.width / png.width,
            scaleY: page.height / png.height,
          },
        }),
      },
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ];
  });
  const tool: McpTool = {
    name: "carrot_render_page_preview",
    description: "Native renderer fixture boundary",
    inputSchema: {},
    requiredScopes: ["carrot.read", "carrot.images"],
    readOnly: true,
    invoke: render,
  };
  const review = new McpCompositeNativeReview([tool], f.options, now);
  const issue = async () => {
    const evidence = await review.renderEvidence(
      f.record,
      "review",
      1,
      new AbortController().signal,
      f.guard,
    );
    f.record.phases[0].evidence = evidence;
    return evidence;
  };
  return {
    ...f,
    review,
    render,
    issue,
    redaction: (enabled: boolean) =>
      setImageRedactionEnabled(enabled, f.env.root),
    close: async () => {
      review.close();
      await f.close();
    },
  };
}
