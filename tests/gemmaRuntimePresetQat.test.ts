import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import {
  GEMMA_RUNTIME_PRESETS,
  resolveModelSpecificGemmaRuntimePreset,
  SPEED_GEMMA_FULL_GPU_THRESHOLDS_MB,
} from "../src/main/settings/gemmaRuntimePresets";
import {
  getDefaultMmprojForGemmaModel,
  isBuiltInGemmaMmproj,
  resolveRuntimeGemmaSettings,
} from "../src/main/settings/gemmaModelPresets";
import { resolveTranslationRuntimeState } from "../src/main/settings/translationGemmaOptions";
import {
  resolveGemmaCacheOptions,
  resolveGemmaGpuOptions,
} from "../src/main/settings/translationGemmaFieldOptions";
import {
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
} from "../src/shared/modelPresets";

describe("QAT Gemma runtime preset routing", () => {
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
  });

  it("uses 512 MiB for 12B and 1024 MiB for larger presets", () => {
    expect(
      Object.values(GEMMA_RUNTIME_PRESETS).map((preset) => preset.fitTargetMb),
    ).toEqual([512, 1024, 1024]);
  });

  it("keeps minimum-card fitting but fully offloads speed models at their nominal high-VRAM tiers", () => {
    const defaults = resolveDefaultAppSettings();
    const cases = [
      {
        preset: GEMMA_RUNTIME_PRESETS.minimum12b,
        repo: GEMMA_12B_QAT_MODEL_REPO,
        file: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
        thresholdMb: SPEED_GEMMA_FULL_GPU_THRESHOLDS_MB.qat12b,
      },
      {
        preset: GEMMA_RUNTIME_PRESETS.economy26b,
        repo: GEMMA_26B_QAT_MODEL_REPO,
        file: GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
        thresholdMb: SPEED_GEMMA_FULL_GPU_THRESHOLDS_MB.qat26b,
      },
      {
        preset: GEMMA_RUNTIME_PRESETS.full31b,
        repo: GEMMA_31B_QAT_MODEL_REPO,
        file: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
        thresholdMb: SPEED_GEMMA_FULL_GPU_THRESHOLDS_MB.qat31b,
      },
    ] as const;

    for (const testCase of cases) {
      const gemma = {
        ...defaults.gemma,
        modelSource: "huggingface" as const,
        modelRepo: testCase.repo,
        modelFile: testCase.file,
      };
      expect(
        resolveModelSpecificGemmaRuntimePreset(
          testCase.preset,
          gemma,
          "cuda12",
          testCase.thresholdMb - 129,
        ),
      ).toMatchObject({ gpuLayers: "fit" });
      expect(
        resolveModelSpecificGemmaRuntimePreset(
          testCase.preset,
          gemma,
          "cuda12",
          testCase.thresholdMb - 128,
        ),
      ).toMatchObject({ gpuLayers: "all", fitEnabled: false });
      expect(
        resolveModelSpecificGemmaRuntimePreset(
          testCase.preset,
          gemma,
          "metal",
          64 * 1024,
        ),
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

    expect(resolveModelSpecificGemmaRuntimePreset(preset, localGemma)).toBe(
      preset,
    );
    expect(resolveModelSpecificGemmaRuntimePreset(preset, defaults.gemma)).toBe(
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
        ctx: 12_288,
        ctxCap: 12_288,
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
    expect(state.settingsCtx).toBe(12_288);
    expect(state.gemmaRuntimePreset.fitTargetMb).toBe(512);
  });
});
