import { resolveRegionTypesettingRequest } from "../src/main/pipeline/codexTypesettingConfiguration";
import { describe, expect, it, vi } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { acquireInpaintingEngineIfNeeded } from "../src/main/jobs/inpaintingJobEngine";
import {
  prepareBubbleLayoutJob,
  runBubbleLayoutOnlyPage,
} from "../src/main/jobs/bubbleLayoutJob";
import { productionInpaintingJobRuntime } from "../src/main/jobs/inpaintingJobRuntime";
import type { InpaintingJobContext } from "../src/main/jobs/inpaintingJobTypes";
import type { AppPaths } from "../src/main/appPaths";
import type { InpaintingEngineLease } from "../src/main/inpainting/inpaintingEnginePool";
import { makePage, makeBlock } from "./unifiedInpaintingUiFixtures";

function fixture() {
  const settings = resolveDefaultAppSettings({});
  settings.modelProvider = "openai-codex";
  settings.codex = {
    ...settings.codex,
    model: "gpt-6-astra",
    reasoningEffort: "low",
    delegateAll: true,
  };
  const lease: InpaintingEngineLease = {
    engine: {
      model: "codex",
      backend: "imagegen",
      runtimePath: "codex",
      runRootDir: "fixture",
      inpaint: vi.fn(),
      dispose: vi.fn(),
    },
    release: vi.fn(),
  };
  const runner = {
    runPage: vi.fn(async () => ({
      patches: [
        {
          blockId: "block-1",
          renderBbox: { x: 10, y: 15, w: 140, h: 130 },
          renderBboxSpace: "normalized_1000" as const,
        },
      ],
    })),
  };
  const runtime = {
    ...productionInpaintingJobRuntime,
    getSettings: vi.fn(async () => settings),
    acquireEngine: vi.fn(productionInpaintingJobRuntime.acquireEngine),
    acquireCodexEngine: vi.fn(async () => lease),
    createBubbleLayoutRunner: vi.fn(
      productionInpaintingJobRuntime.createBubbleLayoutRunner,
    ),
    createCodexBubbleLayoutRunner: vi.fn(() => runner),
  };
  const context = {
    appPaths: {
      dataRoot: "C:\\fixture",
      settingsPath: "C:\\fixture\\settings.json",
    } as AppPaths,
  } as InpaintingJobContext;
  const input = {
    abortController: new AbortController(),
    appSettings: settings,
    context,
    emit: vi.fn(),
    id: "erase",
    shouldAcquireEngine: true,
    pageCount: 1,
    totalTargetBlocks: 1,
    runtime,
  };
  return { settings, lease, runner, runtime, context, input };
}

describe("manual Codex routing", () => {
  it("selects ImageGen without touching the configured Flux model and awaits its release", async () => {
    const { lease, runtime, input } = fixture();
    const result = await acquireInpaintingEngineIfNeeded(input);
    expect(result).toBe(lease);
    expect(runtime.acquireCodexEngine).toHaveBeenCalledExactlyOnceWith(
      input.context.appPaths,
      input.appSettings,
      input.abortController.signal,
    );
    expect(runtime.acquireEngine).not.toHaveBeenCalled();
    await result?.release();
    expect(lease.release).toHaveBeenCalledOnce();
  });
  it("surfaces disconnection instead of silently falling back to Flux", async () => {
    const { runtime, input } = fixture();
    runtime.acquireCodexEngine.mockRejectedValueOnce(
      new Error("Codex disconnected"),
    );
    await expect(acquireInpaintingEngineIfNeeded(input)).rejects.toThrow(
      "Codex disconnected",
    );
    expect(runtime.acquireEngine).not.toHaveBeenCalled();
  });
  it("does not start any model for empty or layout-only erase targets", async () => {
    const { runtime, input } = fixture();
    await expect(
      acquireInpaintingEngineIfNeeded({ ...input, shouldAcquireEngine: false }),
    ).resolves.toBeNull();
    await expect(
      acquireInpaintingEngineIfNeeded({ ...input, totalTargetBlocks: 0 }),
    ).resolves.toBeNull();
    expect(runtime.acquireCodexEngine).not.toHaveBeenCalled();
    expect(runtime.acquireEngine).not.toHaveBeenCalled();
  });
  it("uses Astra for manual balloon fitting and preserves source text and image pixels", async () => {
    const { context, runtime, runner } = fixture();
    const page = { ...makePage(), blocks: [makeBlock()] };
    const prepared = await prepareBubbleLayoutJob({
      context,
      runtime,
      request: {
        mode: "page-bubble-layout",
        chapterId: "chapter-1",
        pageId: page.id,
        blockId: page.blocks[0].id,
        policy: "balanced",
      },
      totalTargetBlocks: 1,
    });
    const result = await runBubbleLayoutOnlyPage({
      ...prepared,
      page,
      blockId: page.blocks[0].id,
      signal: new AbortController().signal,
    });
    expect(runtime.createBubbleLayoutRunner).not.toHaveBeenCalled();
    expect(runtime.acquireEngine).not.toHaveBeenCalled();
    expect(runner.runPage).toHaveBeenCalledWith(
      expect.objectContaining({ targetBlockIds: [page.blocks[0].id] }),
    );
    expect(result.page.blocks[0]).toMatchObject({
      sourceText: page.blocks[0].sourceText,
      translatedText: page.blocks[0].translatedText,
      bbox: page.blocks[0].bbox,
      renderBbox: { x: 10, y: 15, w: 140, h: 130 },
    });
    expect(result.page.imagePath).toBe(page.imagePath);
    expect(result.page.inpaintedImagePath).toBe(page.inpaintedImagePath);
    expect(result.beforeLayout).toHaveLength(1);
    expect(result.afterLayout).toHaveLength(1);
  });
});

it("snapshots Codex delegation for a region request without allowing a legacy erasure fallback", async () => {
  const { settings } = fixture();
  const request = {
    chapterId: "chapter",
    pageId: "page",
    bbox: { x: 0, y: 0, w: 100, h: 100 },
    eraseOriginal: false,
  };
  const resolved = await resolveRegionTypesettingRequest(request, settings);
  expect(resolved.codexTypesetting).toMatchObject({
    version: 1,
    sfxRendering: "image",
    eraseOriginal: false,
  });
  expect(resolved.eraseOriginal).toBe(false);
  settings.codex.delegateAll = false;
  expect(await resolveRegionTypesettingRequest(request, settings)).toBe(
    request,
  );
});

it("fails explicitly when a Codex adapter is unavailable without acquiring a local model", async () => {
  const { runtime, input, context } = fixture();
  await expect(
    acquireInpaintingEngineIfNeeded({
      ...input,
      runtime: { ...runtime, acquireCodexEngine: undefined },
    }),
  ).rejects.toThrow("Codex 원문 제거");
  await expect(
    prepareBubbleLayoutJob({
      context,
      runtime: { ...runtime, createCodexBubbleLayoutRunner: undefined },
      request: {
        mode: "page-bubble-layout",
        policy: "balanced",
        chapterId: "chapter-1",
        pageId: "p1",
      },
      totalTargetBlocks: 1,
    }),
  ).rejects.toThrow("Codex 말풍선 배치");
  expect(runtime.acquireEngine).not.toHaveBeenCalled();
  expect(runtime.createBubbleLayoutRunner).not.toHaveBeenCalled();
});
