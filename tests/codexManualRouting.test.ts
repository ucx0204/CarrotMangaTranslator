import { describe, expect, it, vi } from "vitest";
import {
  resolveDefaultAppSettings,
  normalizeAppSettings,
} from "../src/main/appSettings";
import { AppSettingsSchema } from "../src/shared/ipcSettingsSchemas";
import { acquireInpaintingEngineIfNeeded } from "../src/main/jobs/inpaintingJobEngine";
import { productionInpaintingJobRuntime } from "../src/main/jobs/inpaintingJobRuntime";
import type { InpaintingJobContext } from "../src/main/jobs/inpaintingJobTypes";
import type { AppPaths } from "../src/main/appPaths";
import type { InpaintingEngineLease } from "../src/main/inpainting/inpaintingEnginePool";

function fixture() {
  const settings = resolveDefaultAppSettings({});
  settings.modelProvider = "openai-codex";
  settings.codex = {
    ...settings.codex,
    model: "gpt-6-astra",
    reasoningEffort: "low",
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
    engine: "codex" as const,
  };
  return { settings, lease, runner, runtime, context, input };
}

describe("manual Codex routing", () => {
  it("rejects a missing Codex engine port without starting the local model", async () => {
    const { input, runtime } = fixture();
    await expect(
      acquireInpaintingEngineIfNeeded({
        ...input,
        engine: "codex",
        runtime: { ...runtime, acquireCodexEngine: undefined },
      }),
    ).rejects.toThrow("Codex 원문 제거를 사용할 수 없습니다");
    expect(runtime.acquireEngine).not.toHaveBeenCalled();
  });
  it("preserves the erasure default through settings validation and stored normalization", () => {
    const { settings } = fixture();
    for (const enabled of [true, false]) {
      settings.ui = { ...settings.ui, codexErasureDefault: enabled };
      const validated = AppSettingsSchema.parse(settings);
      const restored = normalizeAppSettings(
        JSON.parse(JSON.stringify(validated)),
      );
      expect(restored.ui?.codexErasureDefault).toBe(enabled);
    }
    expect(normalizeAppSettings({}).ui?.codexErasureDefault).toBe(false);
  });
  it("uses a per-run Codex override with delegation off and never falls back on failure", async () => {
    const { settings, runtime, input, lease } = fixture();
    await expect(
      acquireInpaintingEngineIfNeeded({ ...input, engine: "codex" }),
    ).resolves.toBe(lease);
    runtime.acquireCodexEngine.mockRejectedValueOnce(
      new Error("Codex disconnected"),
    );
    await expect(
      acquireInpaintingEngineIfNeeded({ ...input, engine: "codex" }),
    ).rejects.toThrow("Codex disconnected");
    expect(runtime.acquireEngine).not.toHaveBeenCalled();
    settings.codex.model = "gpt-5.6-sol";
    await expect(
      acquireInpaintingEngineIfNeeded({ ...input, engine: "codex" }),
    ).resolves.toBe(lease);
  });
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
});
