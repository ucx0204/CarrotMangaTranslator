import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import {
  GEMMA_RUNTIME_PRESETS,
  resolveModelSpecificGemmaRuntimePreset,
} from "../src/main/settings/gemmaRuntimePresets";
import {
  getDefaultGemmaPresetForVramMode,
  getDefaultMmprojForGemmaModel,
  getModeAwareGemmaDefaults,
  isBuiltInGemmaMmproj,
  isSpeedGemmaModel,
  resolveRuntimeGemmaSettings,
} from "../src/main/settings/gemmaModelPresets";
import { resolveTranslationRuntimeState } from "../src/main/settings/translationGemmaOptions";
import {
  resolveGemmaCacheOptions,
  resolveGemmaGenerationOptions,
  resolveGemmaGpuOptions,
} from "../src/main/settings/translationGemmaFieldOptions";
import {
  DEFAULT_GEMMA_CONTEXT_TOKENS,
  GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_12B_QAT_MODEL_REPO,
  GEMMA_12B_MMPROJ_FILE,
  GEMMA_12B_MMPROJ_REPO,
  GEMMA_12B_QAT_MMPROJ_FILE,
  GEMMA_12B_QAT_MMPROJ_REPO,
  GEMMA_12B_QAT_MTP_MODEL_FILE,
  GEMMA_12B_QAT_MTP_MODEL_REPO,
  GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_26B_QAT_MODEL_REPO,
  GEMMA_26B_MMPROJ_FILE,
  GEMMA_26B_MMPROJ_REPO,
  GEMMA_26B_QAT_MMPROJ_FILE,
  GEMMA_26B_QAT_MMPROJ_REPO,
  GEMMA_26B_QAT_MTP_MODEL_FILE,
  GEMMA_26B_QAT_MTP_MODEL_REPO,
  GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_31B_QAT_MODEL_REPO,
  GEMMA_31B_MMPROJ_FILE,
  GEMMA_31B_MMPROJ_REPO,
  GEMMA_31B_QAT_MMPROJ_FILE,
  GEMMA_31B_QAT_MMPROJ_REPO,
  GEMMA_31B_QAT_MTP_MODEL_FILE,
  GEMMA_31B_QAT_MTP_MODEL_REPO,
  GEMMA_MODEL_PRESETS,
} from "../src/shared/modelPresets";

describe("QAT Gemma runtime preset routing", () => {
  it("recognizes every speed model without accepting a legacy preset", () => {
    const speedModels = [
      {
        mode: "minimum12b" as const,
        modelRepo: GEMMA_12B_QAT_MODEL_REPO,
        modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
      },
      {
        mode: "economy26b" as const,
        modelRepo: GEMMA_26B_QAT_MODEL_REPO,
        modelFile: GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
      },
      {
        mode: "full31b" as const,
        modelRepo: GEMMA_31B_QAT_MODEL_REPO,
        modelFile: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
      },
    ];
    for (const model of speedModels) {
      expect(isSpeedGemmaModel(model)).toBe(true);
      expect(getDefaultGemmaPresetForVramMode(model.mode)).toMatchObject({
        modelRepo: model.modelRepo,
        modelFile: model.modelFile,
      });
    }
    expect(isSpeedGemmaModel(GEMMA_MODEL_PRESETS.minimum12b)).toBe(false);

    const defaults = resolveDefaultAppSettings();
    expect(
      getModeAwareGemmaDefaults(
        {
          ...defaults,
          gemma: {
            ...defaults.gemma,
            ...GEMMA_MODEL_PRESETS.minimum12b,
          },
        },
        "full31b",
      ),
    ).toEqual({
      modelRepo: GEMMA_MODEL_PRESETS.full31b.modelRepo,
      modelFile: GEMMA_MODEL_PRESETS.full31b.modelFile,
      mmprojRepo: GEMMA_MODEL_PRESETS.full31b.mmprojRepo,
      mmprojFile: GEMMA_MODEL_PRESETS.full31b.mmprojFile,
    });
  });

  it("recognizes every built-in mmproj pair without accepting lookalikes", () => {
    const pairs = [
      [GEMMA_12B_MMPROJ_REPO, GEMMA_12B_MMPROJ_FILE],
      [GEMMA_12B_QAT_MMPROJ_REPO, GEMMA_12B_QAT_MMPROJ_FILE],
      [GEMMA_26B_MMPROJ_REPO, GEMMA_26B_MMPROJ_FILE],
      [GEMMA_26B_QAT_MMPROJ_REPO, GEMMA_26B_QAT_MMPROJ_FILE],
      [GEMMA_31B_MMPROJ_REPO, GEMMA_31B_MMPROJ_FILE],
      [GEMMA_31B_QAT_MMPROJ_REPO, GEMMA_31B_QAT_MMPROJ_FILE],
    ] as const;

    for (const [repo, file] of pairs) {
      expect(isBuiltInGemmaMmproj(repo, file)).toBe(true);
    }
    expect(
      isBuiltInGemmaMmproj(
        GEMMA_12B_MMPROJ_REPO,
        GEMMA_12B_MMPROJ_FILE.toUpperCase(),
      ),
    ).toBe(true);
    expect(isBuiltInGemmaMmproj()).toBe(false);
    expect(isBuiltInGemmaMmproj("unknown/repo", "mmproj.gguf")).toBe(false);
    expect(
      isBuiltInGemmaMmproj(GEMMA_31B_QAT_MMPROJ_REPO, "lookalike.gguf"),
    ).toBe(false);
    expect(getDefaultMmprojForGemmaModel(GEMMA_MODEL_PRESETS.full31b)).toEqual({
      mmprojRepo: GEMMA_31B_MMPROJ_REPO,
      mmprojFile: GEMMA_31B_MMPROJ_FILE,
    });
  });

  it("uses model-sized free-VRAM targets and 1536 MiB for 31B", () => {
    expect(
      Object.values(GEMMA_RUNTIME_PRESETS).map((preset) => preset.fitTargetMb),
    ).toEqual([512, 1024, 1536]);
  });

  it.each([
    {
      mode: "minimum12b" as const,
      modelRepo: GEMMA_12B_QAT_MODEL_REPO,
      modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
    },
    {
      mode: "economy26b" as const,
      modelRepo: GEMMA_26B_QAT_MODEL_REPO,
      modelFile: GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
    },
    {
      mode: "full31b" as const,
      modelRepo: GEMMA_31B_QAT_MODEL_REPO,
      modelFile: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
    },
  ])(
    "passes the configured context through unchanged for $mode",
    ({ mode, modelRepo, modelFile }) => {
      const defaults = resolveDefaultAppSettings();
      const settings = {
        ...defaults,
        ctx: 77_777,
        gemma: {
          ...defaults.gemma,
          modelSource: "huggingface" as const,
          modelRepo,
          modelFile,
          vramMode: mode,
          llamaRuntimeProfile: "cuda12" as const,
        },
      };
      const state = resolveTranslationRuntimeState({}, settings);
      const generation = resolveGemmaGenerationOptions(
        {},
        settings,
        state.settingsCtx,
        state.gemmaRuntimePreset,
      );

      expect(state.settingsCtx).toBe(77_777);
      expect(generation.ctx).toBe(77_777);
    },
  );

  it("keeps configured fit routing on every speed model regardless of detected VRAM", () => {
    const defaults = resolveDefaultAppSettings();
    const cases = [
      {
        preset: GEMMA_RUNTIME_PRESETS.minimum12b,
        repo: GEMMA_12B_QAT_MODEL_REPO,
        file: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
      },
      {
        preset: GEMMA_RUNTIME_PRESETS.economy26b,
        repo: GEMMA_26B_QAT_MODEL_REPO,
        file: GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
      },
      {
        preset: GEMMA_RUNTIME_PRESETS.full31b,
        repo: GEMMA_31B_QAT_MODEL_REPO,
        file: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
      },
    ] as const;

    for (const testCase of cases) {
      const preset = { ...testCase.preset, fitTargetMb: 1536 };
      const gemma = {
        ...defaults.gemma,
        modelSource: "huggingface" as const,
        modelRepo: testCase.repo,
        modelFile: testCase.file,
      };
      expect(
        resolveModelSpecificGemmaRuntimePreset(preset, gemma, "cuda12"),
      ).toMatchObject({ fitTargetMb: 1536, gpuLayers: "fit" });
      expect(
        resolveModelSpecificGemmaRuntimePreset(preset, gemma, "metal"),
      ).not.toHaveProperty("fitEnabled", false);
    }
  });

  it("lets explicit environment routing override the automatic full-offload tier", () => {
    const preset = {
      ...GEMMA_RUNTIME_PRESETS.minimum12b,
      fitEnabled: false,
      gpuLayers: "all" as const,
    };
    expect(
      resolveGemmaGpuOptions(
        { MANGA_TRANSLATOR_GEMMA_GPU_LAYERS: "fit" },
        preset,
      ),
    ).toMatchObject({ gpuLayers: "fit", fitEnabled: true });
    expect(
      resolveGemmaGpuOptions(
        {
          MANGA_TRANSLATOR_GEMMA_GPU_LAYERS: "all",
          MANGA_TRANSLATOR_GEMMA_FIT: "off",
        },
        GEMMA_RUNTIME_PRESETS.minimum12b,
      ),
    ).toMatchObject({ gpuLayers: "all", fitEnabled: false });
  });

  it("enables MTP only on supported CUDA profiles", () => {
    const defaults = resolveDefaultAppSettings();
    const preset = GEMMA_RUNTIME_PRESETS.minimum12b;
    const qatGemma = {
      ...defaults.gemma,
      modelSource: "huggingface" as const,
      modelRepo: GEMMA_12B_QAT_MODEL_REPO,
      modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
    };

    for (const profile of ["cuda12", "rtx50"] as const) {
      expect(
        resolveModelSpecificGemmaRuntimePreset(preset, qatGemma, profile),
      ).toMatchObject({
        batch: 1024,
        ubatch: 1024,
        fitTargetMb: 512,
        useDraft: true,
        draftSpecType: "draft-mtp",
        draftModelRepo: GEMMA_12B_QAT_MTP_MODEL_REPO,
        draftModelFile: GEMMA_12B_QAT_MTP_MODEL_FILE,
        draftMaxTokens: 8,
      });
    }
    expect(
      resolveModelSpecificGemmaRuntimePreset(preset, qatGemma, "vulkan"),
    ).toMatchObject({ useDraft: false });
  });

  it("leaves local and non-QAT models on their selected preset", () => {
    const defaults = resolveDefaultAppSettings();
    const preset = GEMMA_RUNTIME_PRESETS.full31b;
    const localGemma = {
      ...defaults.gemma,
      modelSource: "local" as const,
      localModelPath: "C:/models/custom.gguf",
    };
    const nonQatGemma = {
      ...defaults.gemma,
      ...GEMMA_MODEL_PRESETS.minimum12b,
    };

    expect(resolveModelSpecificGemmaRuntimePreset(preset, localGemma)).toBe(
      preset,
    );
    expect(resolveModelSpecificGemmaRuntimePreset(preset, nonQatGemma)).toBe(
      preset,
    );
  });

  it("enables the 26B MTP head on supported CUDA profiles", () => {
    const defaults = resolveDefaultAppSettings();
    const preset = GEMMA_RUNTIME_PRESETS.economy26b;
    const qatGemma = {
      ...defaults.gemma,
      modelSource: "huggingface" as const,
      modelRepo: GEMMA_26B_QAT_MODEL_REPO,
      modelFile: GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
    };

    for (const profile of ["cuda12", "rtx50"] as const) {
      expect(
        resolveModelSpecificGemmaRuntimePreset(preset, qatGemma, profile),
      ).toMatchObject({
        batch: 1024,
        ubatch: 1024,
        fitTargetMb: 1024,
        gpuLayers: "fit",
        cacheTypeK: "q4_0",
        cacheTypeV: "q4_0",
        ctxCheckpoints: 0,
        kvOffload: true,
        mmprojOffload: true,
        disableMmap: true,
        threads: 10,
        threadsBatch: 12,
        useDraft: true,
        draftSpecType: "draft-mtp",
        draftModelRepo: GEMMA_26B_QAT_MTP_MODEL_REPO,
        draftModelFile: GEMMA_26B_QAT_MTP_MODEL_FILE,
        draftMaxTokens: 2,
      });
    }
    expect(
      resolveModelSpecificGemmaRuntimePreset(preset, qatGemma, "vulkan"),
    ).toMatchObject({ useDraft: false });

    expect(
      resolveModelSpecificGemmaRuntimePreset(
        { ...preset, fitTargetMb: 2048 },
        qatGemma,
        "cuda12",
      ).fitTargetMb,
    ).toBe(2048);
  });

  it("normalizes draft strategy environment aliases", () => {
    const preset = GEMMA_RUNTIME_PRESETS.full31b;

    expect(
      resolveGemmaCacheOptions(
        { MANGA_TRANSLATOR_DRAFT_SPEC_TYPE: " DFLASH " },
        preset,
      ).draftSpecType,
    ).toBe("dflash");
    for (const value of ["draft-mtp", "MTP"]) {
      expect(
        resolveGemmaCacheOptions(
          { MANGA_TRANSLATOR_DRAFT_SPEC_TYPE: value },
          preset,
        ).draftSpecType,
      ).toBe("draft-mtp");
    }
    expect(
      resolveGemmaCacheOptions(
        { MANGA_TRANSLATOR_DRAFT_SPEC_TYPE: "unsupported" },
        preset,
      ).draftSpecType,
    ).toBe("dflash");
  });

  it("enables the 31B MTP head with the dedicated 24 GB speed settings", () => {
    const defaults = resolveDefaultAppSettings();
    const preset = GEMMA_RUNTIME_PRESETS.full31b;
    const qatGemma = {
      ...defaults.gemma,
      modelSource: "huggingface" as const,
      modelRepo: GEMMA_31B_QAT_MODEL_REPO,
      modelFile: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
    };

    expect(getDefaultMmprojForGemmaModel(qatGemma)).toEqual({
      mmprojRepo: GEMMA_31B_QAT_MMPROJ_REPO,
      mmprojFile: GEMMA_31B_QAT_MMPROJ_FILE,
    });

    const localGemma = {
      ...qatGemma,
      modelSource: "local" as const,
      localModelPath: "C:/models/gemma-31b.gguf",
    };
    expect(resolveRuntimeGemmaSettings(localGemma, "full31b")).toBe(localGemma);

    for (const profile of ["cuda12", "rtx50"] as const) {
      expect(
        resolveModelSpecificGemmaRuntimePreset(preset, qatGemma, profile),
      ).toMatchObject({
        ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
        batch: 1024,
        ubatch: 1024,
        fitTargetMb: 1536,
        gpuLayers: "fit",
        cacheTypeK: "q4_0",
        cacheTypeV: "q4_0",
        ctxCheckpoints: 0,
        kvOffload: true,
        mmprojOffload: true,
        disableMmap: true,
        threads: 10,
        threadsBatch: 12,
        useDraft: true,
        draftSpecType: "draft-mtp",
        draftModelRepo: GEMMA_31B_QAT_MTP_MODEL_REPO,
        draftModelFile: GEMMA_31B_QAT_MTP_MODEL_FILE,
        draftMaxTokens: 2,
      });
    }
    expect(
      resolveModelSpecificGemmaRuntimePreset(preset, qatGemma, "vulkan"),
    ).toMatchObject({ useDraft: false });

    expect(
      resolveModelSpecificGemmaRuntimePreset(
        { ...preset, fitTargetMb: 2048 },
        qatGemma,
        "cuda12",
      ).fitTargetMb,
    ).toBe(2048);

    const state = resolveTranslationRuntimeState(
      {},
      {
        ...defaults,
        ctx: 65_536,
        gemma: {
          ...qatGemma,
          vramMode: "full31b",
          fitTargetMb: 512,
          llamaRuntimeProfile: "cuda12",
        },
      },
    );
    expect(state.settingsCtx).toBe(65_536);
    expect(state.gemmaRuntimePreset.fitTargetMb).toBe(512);
  });
});
