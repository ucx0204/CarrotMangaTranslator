import { describe, expect, it } from "vitest";
import type { AppSettings } from "../src/shared/settingsTypes";
import { emitOcrPreparation } from "../src/main/pipeline/progressEvents";
import { resolveOcrTranslationOptions } from "../src/main/settings/translationOcrOptions";

const runtimeDevice = require("../src/main/runtime/ocr/runtime-device.cjs") as {
  isPaddleTransformersEngine: (options?: Record<string, unknown>) => boolean;
  resolveOcrGpuCudaTag: (options?: Record<string, unknown>) => string;
};
const installPlan = require("../src/main/runtime/ocr/install-plan.cjs") as {
  resolveOcrPipInstallBatches: (
    options?: Record<string, unknown>,
  ) => string[][];
};
const runtimeErrors = require("../src/main/runtime/ocr/runtime-errors.cjs") as {
  buildOcrRuntimeImportFailureMessage: (
    message: unknown,
    options?: Record<string, unknown>,
  ) => string;
};
const promptBuilder =
  require("../src/main/runtime/prompts/ocr-bbox-section.cjs") as {
    buildOcrBboxHintSection: (
      options?: Record<string, unknown>,
      imageVariants?: Array<Record<string, unknown>>,
    ) => string[];
  };

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("OCR engine boundary regressions", () => {
  it("brands Hayai preparation progress without passing through Paddle text", () => {
    const events: Array<Record<string, unknown>> = [];
    const context = {
      jobId: "hayai-progress",
      emit: (event: Record<string, unknown>) => events.push(event),
      progressTotal: 1,
      pageTotal: 1,
      ocrPipeline: "hayai",
    } as Parameters<typeof emitOcrPreparation>[0];

    emitOcrPreparation(context, false);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "ocr_preparing",
      ocrPipeline: "hayai",
    });
    expect(JSON.stringify(events[0])).not.toMatch(/Paddle/i);
  });

  it("uses the detector-owned Hayai candidate contract", () => {
    const section = promptBuilder.buildOcrBboxHintSection({
      ocrPipeline: "hayai",
      imageWidth: 100,
      imageHeight: 100,
      ocrBboxHints: [
        {
          id: 1,
          label: "D001",
          x1: 10,
          y1: 20,
          x2: 40,
          y2: 80,
          ocrText: "テスト",
        },
      ],
    });

    expect(section).toContain("Locked ordinary-text regions (HayaiOCR)");
    expect(section.join("\n")).toContain(
      "Candidate ids to translate independently: 1.",
    );
    expect(section.join("\n")).toContain("candidate 1:");
  });

  it("derives a default quality mode when settings do not persist one", () => {
    const settings = {
      ocr: {
        pipeline: "hayai",
        device: "cpu",
        gpuBackend: "cuda",
        gpuCudaTag: "cu126",
      },
    } as AppSettings;

    const options = resolveOcrTranslationOptions({}, settings, "full31b");

    expect(options).toMatchObject({
      ocrPipeline: "hayai",
      ocrDevice: "cpu",
      ocrQualityMode: "economy",
      ocrBboxProvider: "hayai-regions",
    });
  });

  it("keeps generic Hayai import failures engine-specific on CPU and GPU", () => {
    const cpuMessage = runtimeErrors.buildOcrRuntimeImportFailureMessage(
      "plain processor import failure",
      { ocrPipeline: "hayai", ocrDevice: "cpu" },
    );
    const gpuMessage = runtimeErrors.buildOcrRuntimeImportFailureMessage("", {
      ocrPipeline: "hayai",
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
    });

    expect(cpuMessage).toContain("HayaiOCR CPU");
    expect(gpuMessage).toContain("HayaiOCR NVIDIA GPU");
    expect(`${cpuMessage} ${gpuMessage}`).not.toMatch(/Paddle/i);
  });

  it("does not interpret Hayai as Paddle Transformers and normalizes loose CUDA tags", () => {
    const envKeys = [
      "MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG",
      "MANGA_TRANSLATOR_OCR_GPU_CUDA",
    ];
    const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
    try {
      for (const key of envKeys) delete process.env[key];
      expect(
        runtimeDevice.isPaddleTransformersEngine({ ocrPipeline: "hayai" }),
      ).toBe(false);
      expect(
        runtimeDevice.resolveOcrGpuCudaTag({
          ocrPipeline: "hayai",
          ocrGpuCudaTag: "CUDA 129",
        }),
      ).toBe("cu129");
      expect(
        runtimeDevice.resolveOcrGpuCudaTag({
          ocrPipeline: "hayai",
          ocrGpuCudaTag: "invalid",
        }),
      ).toMatch(/^cu\d+$/);
    } finally {
      for (const [key, value] of previous) restoreEnv(key, value);
    }
  });

  it("honors only Hayai-specific explicit package plans for every device route", () => {
    const keys = [
      "MANGA_TRANSLATOR_HAYAI_OCR_PIP_PACKAGES",
      "MANGA_TRANSLATOR_HAYAI_OCR_CPU_PIP_PACKAGES",
      "MANGA_TRANSLATOR_HAYAI_OCR_CUDA_PIP_PACKAGES",
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.MANGA_TRANSLATOR_HAYAI_OCR_PIP_PACKAGES = "hayai-global==1";
      expect(
        installPlan.resolveOcrPipInstallBatches({
          ocrPipeline: "hayai",
          ocrDevice: "cpu",
        }),
      ).toEqual([["hayai-global==1"]]);

      delete process.env.MANGA_TRANSLATOR_HAYAI_OCR_PIP_PACKAGES;
      process.env.MANGA_TRANSLATOR_HAYAI_OCR_CPU_PIP_PACKAGES = "hayai-cpu==1";
      expect(
        installPlan.resolveOcrPipInstallBatches({
          ocrPipeline: "hayai",
          ocrDevice: "cpu",
        }),
      ).toEqual([["hayai-cpu==1"]]);

      delete process.env.MANGA_TRANSLATOR_HAYAI_OCR_CPU_PIP_PACKAGES;
      process.env.MANGA_TRANSLATOR_HAYAI_OCR_CUDA_PIP_PACKAGES =
        "hayai-cuda==1";
      expect(
        installPlan.resolveOcrPipInstallBatches({
          ocrPipeline: "hayai",
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
        }),
      ).toEqual([["hayai-cuda==1"]]);
    } finally {
      for (const [key, value] of previous) restoreEnv(key, value);
    }
  });
});
