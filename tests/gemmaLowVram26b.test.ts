import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/settings/appSettingsDefaults";
import { parseStoredAppSettings } from "../src/main/settings/appSettingsNormalize";
import { buildBaseTranslationOptions } from "../src/main/settings/translationOptions";
import { formatGemmaVramMode } from "../src/main/pipeline/options";
import { GEMMA_MODEL_PRESETS } from "../src/shared/modelPresets";
import { GemmaVramModeSchema } from "../src/shared/ipcEnumSchemas";
import { meetsGemmaDedicatedVramRequirement } from "../src/shared/gemmaMemoryPolicy";
import { resolveModelPreset } from "../src/renderer/src/components/settingsOptions";
import { createSettingsFormValues } from "../src/renderer/src/components/settingsModal/settingsModalFormValues";
import {
  buildLaunchArgs,
  collectRequiredHfDownloads,
  createTempDir,
} from "./helpers/runtimeModelContracts";

const gpu = {
  name: "RTX 4060",
  vendor: "nvidia" as const,
  memoryMb: 8192,
  rtxGeneration: 40,
  computeCapability: 8.9,
};
const paths = {
  dataRoot: ".",
  toolsDir: "tools",
  llamaServerPath: "llama-server.exe",
  hfHubCacheDir: createTempDir("low-vram-hf-cache-"),
  llamaCacheDir: createTempDir("low-vram-llama-cache-"),
};
const defaults = () =>
  resolveDefaultAppSettings(
    {
      MANGA_TRANSLATOR_GEMMA_VRAM_MODE: "lowVram26b",
    },
    gpu,
  );
function options(settings = defaults(), env = {}) {
  return buildBaseTranslationOptions({
    jobId: "low-vram-test",
    runDir: ".",
    paths,
    settings,
    env,
  });
}

describe("8 GiB Gemma expert offload", () => {
  it("converts legacy built-in weights when CPU-expert mode is explicitly requested and labels the runtime distinctly", () => {
    const settings = defaults();
    Object.assign(settings.gemma, GEMMA_MODEL_PRESETS.minimum12b);
    const runtime = options(settings, {
      MANGA_TRANSLATOR_GEMMA_VRAM_MODE: "lowVram26b",
    });
    expect(runtime).toMatchObject({
      modelRepo: GEMMA_MODEL_PRESETS.lowVram26b.modelRepo,
      modelFile: GEMMA_MODEL_PRESETS.lowVram26b.modelFile,
      mmprojRepo: GEMMA_MODEL_PRESETS.lowVram26b.mmprojRepo,
      mmprojFile: GEMMA_MODEL_PRESETS.lowVram26b.mmprojFile,
      gemmaVramMode: "lowVram26b",
      cpuMoe: true,
    });
    expect(formatGemmaVramMode(runtime.gemmaVramMode)).toBe(
      "26B 8GB · RAM 사용",
    );
    expect(formatGemmaVramMode(runtime.gemmaVramMode)).not.toBe(
      formatGemmaVramMode("economy26b"),
    );
  });

  it("preserves the 12B default and persists an explicitly selected CPU-expert 26B profile", () => {
    expect(resolveDefaultAppSettings({}, gpu).gemma).toMatchObject(
      GEMMA_MODEL_PRESETS.qat12b,
    );
    const settings = defaults();
    expect(settings.gemma).toMatchObject(GEMMA_MODEL_PRESETS.lowVram26b);
    expect(GemmaVramModeSchema.parse("lowVram26b")).toBe("lowVram26b");
    const stored = parseStoredAppSettings(
      JSON.stringify(settings),
      resolveDefaultAppSettings({}),
    );
    expect(stored.gemma).toEqual(settings.gemma);
    expect(createSettingsFormValues(stored).selectedPreset).toBe("lowVram26b");
    expect(meetsGemmaDedicatedVramRequirement("lowVram26b", 8180)).toBe(true);
  });

  it.each(["cuda12", "rtx50", "vulkan", "rocm", "metal"] as const)(
    "passes CPU experts through the production options and argv on %s without a draft model",
    (profile) => {
      const settings = defaults();
      settings.gemma.llamaRuntimeProfile = profile;
      const runtime = options(settings);
      expect(runtime).toMatchObject({
        cpuMoe: true,
        useDraft: false,
        batch: 1024,
        ubatch: 1024,
        mmprojOffload: true,
        disableMmap: true,
        ctx: 32768,
      });
      const args = buildLaunchArgs(runtime);
      expect(args).toContain("--cpu-moe");
      expect(args).not.toContain("--model-draft");
      expect(collectRequiredHfDownloads(runtime)).toHaveLength(2);
    },
  );

  it("keeps explicit 12B settings and permits switching back without CPU expert flags", () => {
    for (const preset of [
      GEMMA_MODEL_PRESETS.qat12b,
      GEMMA_MODEL_PRESETS.minimum12b,
    ]) {
      const previous = {
        ...defaults(),
        gemma: { ...defaults().gemma, ...preset, fitTargetMb: 777 },
      };
      const restored = parseStoredAppSettings(
        JSON.stringify(previous),
        defaults(),
      );
      expect(restored.gemma).toEqual(previous.gemma);
      expect(buildLaunchArgs(options(restored))).not.toContain("--cpu-moe");
      expect(createSettingsFormValues(restored).selectedPreset).toBe(
        preset === GEMMA_MODEL_PRESETS.qat12b ? "qat12b" : "minimum12b",
      );
    }
  });

  it("distinguishes full GPU 26B from the same weights with CPU experts", () => {
    const preset = GEMMA_MODEL_PRESETS.qat26b;
    expect(resolveModelPreset(preset.modelRepo, preset.modelFile)).toBe(
      "qat26b",
    );
    expect(
      resolveModelPreset(preset.modelRepo, preset.modelFile, "lowVram26b"),
    ).toBe("lowVram26b");
    const settings = {
      ...defaults(),
      gemma: { ...defaults().gemma, ...preset },
    };
    expect(options(settings).cpuMoe).toBeUndefined();
    expect(
      options(settings, { MANGA_TRANSLATOR_GEMMA_VRAM_MODE: "lowVram26b" })
        .cpuMoe,
    ).toBe(true);
  });

  it.each([6144, 8192, 12288, 16384, 24564])(
    "preserves the existing default at %s MiB",
    (memoryMb) => {
      expect(
        resolveDefaultAppSettings({}, { ...gpu, memoryMb }).gemma.vramMode,
      ).toBe(memoryMb >= 16000 ? "economy26b" : "minimum12b");
    },
  );
});
