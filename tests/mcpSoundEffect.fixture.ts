import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { vi } from "vitest";
import { imageEditingFixture } from "./mcpImageEditing.fixture";
import {
  McpSoundEffectPrepareSchema,
  mcpSoundEffectOutputs,
  type McpSoundEffectPrepare,
} from "../src/shared/mcpSoundEffects";
import type { SoundEffectGenerationRuntime } from "../src/main/mcp/mcpSoundEffectGeneration";

export async function soundEffectFixture() {
  const f = await imageEditingFixture();
  const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
  stored.pages[0].blocks[0].textRole = "sound";
  stored.pages[0].blocks[0].sourceText = "\u30c9\u30f3";
  stored.pages[0].blocks[0].translatedText = "\ucfe5";
  stored.pages[0].soundEffectReview = {
    contractVersion: 3,
    producer: "hayai-regions-v1",
    regions: [
      {
        id: "candidate",
        bbox: { x: 750, y: 650, w: 150, h: 200 },
        detectorConfidence: 0.95,
        recognizedText: "\u30c9\u30ab",
      },
    ],
    regionOverrides: [],
    manualRegions: [],
    resolvedRegions: [],
  };
  await writeFile(f.chapterPath, JSON.stringify(stored));
  const { McpPageBatchService } =
    await import("../src/main/application/mcpPageBatchService");
  const { createMcpSoundEffectPolicy } =
    await import("../src/main/application/mcpSoundEffectPolicy");
  const { createMcpSoundEffectPorts } =
    await import("../src/main/mcp/mcpSoundEffectAdapter");
  const { createMcpSoundEffectPreparation } =
    await import("../src/main/mcp/mcpSoundEffectPreparation");
  const { createMcpSoundEffectReadTool } =
    await import("../src/main/mcp/mcpSoundEffectReadTool");
  const { createMcpPageEditScope } =
    await import("../src/main/mcp/mcpPageEditScope");
  const { readMcpSoundEffectSettings } =
    await import("../src/main/mcp/mcpSoundEffectSettings");
  const { mcpToolResult } = await import("../src/main/mcp/mcpToolResult");
  const lifetime = new AbortController();
  const settings = await readMcpSoundEffectSettings(f.app.appPaths);
  const turn = vi.fn<
    Awaited<
      ReturnType<SoundEffectGenerationRuntime["startClient"]>
    >["runEphemeralTurn"]
  >(async () => ({
    itemId: randomUUID(),
    threadId: randomUUID(),
    turnId: randomUUID(),
    text: JSON.stringify({ result: generatedPng().toString("base64") }),
  }));
  const dispose = vi.fn(async () => {});
  const startClient = vi.fn<SoundEffectGenerationRuntime["startClient"]>(
    async () => ({
      imageModel: settings.codex.imageModel,
      runEphemeralTurn: turn,
      dispose,
    }),
  );
  const service = new McpPageBatchService(
    createMcpSoundEffectPorts(f.app, f.editing, lifetime.signal),
    createMcpSoundEffectPolicy(
      createMcpSoundEffectPreparation(f.app.appPaths, { startClient }),
    ),
    Date.now,
    lifetime.signal,
  );
  const reader = createMcpSoundEffectReadTool(f.app.appPaths);
  const query = async (args: object = {}) =>
    mcpSoundEffectOutputs.carrot_get_sound_effects.parse(
      mcpToolResult(
        reader,
        await reader.invoke(
          { chapterId: "chapter", pageId: "page", ...args },
          f.auth(),
        ),
      ).structuredContent,
    );
  const binding = async () => {
    const read = await query();
    return {
      chapterId: read.chapterId,
      pageId: read.pageId,
      revision: read.revision,
      reviewRevision: read.reviewRevision,
      contextRevision: read.contextRevision,
    };
  };
  const input = async (command: McpSoundEffectPrepare["command"]) =>
    McpSoundEffectPrepareSchema.parse({
      ...(await binding()),
      requestId: randomUUID(),
      reason: "Isolated sound-effect test",
      command,
    });
  const own = createMcpPageEditScope(
    f.app,
    f.library.openChapter,
    lifetime.signal,
  );
  const preview = async (command: McpSoundEffectPrepare["command"]) => {
    const request = await input(command);
    const receipt = await own(
      request,
      () => {},
      (guard, signal) => service.preview(f.owner, request, guard, signal),
    );
    return { ...receipt, request };
  };
  const inspect = (batchId: string) =>
    service.inspect(f.owner, { batchId }, () => {});
  const action = async (
    batchId: string,
    direction: "apply" | "undo" | "redo",
    requestId = randomUUID(),
    guard = () => {},
  ) => {
    const receipt = service.start(
      f.owner,
      { batchId, requestId },
      direction,
      guard,
    );
    await vi.waitFor(
      async () => {
        if ((await inspect(batchId)).status === "running")
          throw new Error("Sound-effect action is running");
      },
      { timeout: 10000 },
    );
    return { receipt, result: await inspect(batchId) };
  };
  return {
    ...f,
    lifetime,
    reader,
    query,
    binding,
    input,
    preview,
    inspect,
    action,
    service,
    turn,
    startClient,
    dispose,
    settings,
    close: async () => {
      lifetime.abort();
      await service.close();
      await f.close();
    },
  };
}
function generatedPng() {
  const png = new PNG({ width: 30, height: 30 });
  for (let y = 0; y < 30; y++)
    for (let x = 0; x < 30; x++) {
      const offset = (y * 30 + x) * 4;
      png.data.set(
        x >= 8 && x < 22 && y >= 7 && y < 23
          ? [12, 12, 12, 255]
          : [0, 255, 0, 255],
        offset,
      );
    }
  return PNG.sync.write(png);
}
