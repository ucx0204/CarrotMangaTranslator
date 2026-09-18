import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { vi } from "vitest";
import { typographyAnalysisAppFixture } from "./mcpTypographyAnalysisApp.fixture";
import { imageNativeBoundary } from "./mcpImageNative.fixture";
import { createPageRevision } from "../src/shared/pageRevision";
import { mcpContextRevision } from "../src/shared/mcpContextEditing";
import { McpImageEditPreviewSchema, mcpImageEditOutputs, type McpImageEditCommand } from "../src/shared/mcpImageEditing";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import type { McpImageEditRuntime } from "../src/main/mcp/mcpImageEditExecution";

export async function imageEditingFixture() {
  const f = await typographyAnalysisAppFixture(imageNativeBoundary);
  const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
  for (const page of stored.pages)
    for (const block of page.blocks) block.bboxSpace = "pixels";
  await writeFile(f.chapterPath, JSON.stringify(stored));
  const { InpaintingRevisionStore } = await import("../src/main/inpainting/inpaintingRevisionStore");
  const { createMcpImageEditSession } = await import("../src/main/mcp/mcpImageEditSession");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const { getAppSettings } = await import("../src/main/settingsStore");
  const settings = await getAppSettings(f.app.appPaths);
  settings.inpainting = { ...settings.inpainting, model: "lama-manga" };
  const history = new InpaintingRevisionStore();
  const app = { ...f.app, inpaintingRevisionStore: history };
  const inpaint = vi.fn<InpaintingEngine["inpaint"]>(async (bitmap) => {
    // Adversarial native transport: tries to modify EVERY pixel, including alpha.
    // The real prepared-mask compositor must restore all unselected pixels.
    for (let i = 0; i < bitmap.length; i += 4) {
      bitmap[i] = 33; bitmap[i + 1] = 66; bitmap[i + 2] = 99; bitmap[i + 3] = 170;
    }
  });
  const engine: InpaintingEngine = {
    model: "lama-manga", runtimePath: "fixture-native", backend: "cpu",
    runRootDir: f.env.root, inpaint, dispose: async () => {},
  };
  const release = vi.fn(async () => {});
  const acquireEngine = vi.fn<McpImageEditRuntime["acquireEngine"]>(async () => ({ engine, release }));
  const getSettings = vi.fn<McpImageEditRuntime["getSettings"]>(async () => settings);
  const editing = { assertWritable: vi.fn(async () => {}), notifySaved: vi.fn() };
  const session = createMcpImageEditSession(app, editing, true, true, { getSettings, acquireEngine });
  const owner = "image-owner";
  const auth = (principalId = owner) => ({ principalId,
    assertAuthorized: vi.fn(), assertScopes: vi.fn(), assertJobAuthorized: vi.fn() });
  const invoke = async (name: string, args: object, caller = auth()) => {
    const tool = session.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Missing image tool ${name}`);
    const reply = mcpToolResult(tool, await tool.invoke(args as Record<string, unknown>, caller));
    if (reply.isError) throw new Error(JSON.stringify(reply.structuredContent));
    return reply;
  };
  const snapshot = () => f.library.openChapter("chapter");
  const input = async (command: McpImageEditCommand) => {
    const saved = await f.library.readWorkContextForEdit("chapter");
    return McpImageEditPreviewSchema.parse({
      chapterId: "chapter", pageId: "page", revision: createPageRevision(saved.chapter.pages[0]),
      contextRevision: mcpContextRevision(saved), requestId: randomUUID(),
      reason: "Explicit isolated image edit", command,
    });
  };
  const preview = async (command: McpImageEditCommand) => {
    const request = await input(command);
    const reply = await invoke("carrot_preview_image_edit", request);
    return { request, ...mcpImageEditOutputs.carrot_preview_image_edit.parse(reply.structuredContent) };
  };
  const inspect = async (batchId: string) => mcpImageEditOutputs.carrot_get_image_edit.parse(
    (await invoke("carrot_get_image_edit", { batchId })).structuredContent,
  );
  const done = async (batchId: string) => {
    await vi.waitFor(async () => {
      if ((await inspect(batchId)).status === "running") throw new Error("Image edit still running");
    }, { timeout: 10000 });
    return inspect(batchId);
  };
  const action = async (batchId: string, direction: string, requestId = randomUUID()) => {
    const receipt = await invoke(`carrot_${direction}_image_edit`, { batchId, requestId });
    return { receipt, result: await done(batchId) };
  };
  const pixels = async (path: string) => PNG.sync.read(await readFile(path));
  return { ...f, app, history, session, editing, settings, owner, auth, invoke, snapshot,
    input, preview, inspect, done, action, pixels, inpaint, acquireEngine, release, getSettings,
    close: async () => {
      await session.close();
      await history.releaseAll();
      await f.close();
    },
  };
}
export function brushCommand(): McpImageEditCommand {
  return { kind: "erase-mask", expectedEngine: "lama-manga", allowAssetDownloads: true,
    strokes: [{ points: [{ x: 25, y: 35 }], radiusPx: 8 }], protectedAreas: [
      { kind: "rectangle", start: { x: 25, y: 25 }, end: { x: 35, y: 45 } },
    ] };
}
