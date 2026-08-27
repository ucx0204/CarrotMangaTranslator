import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MODEL_REPO,
  GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_12B_QAT_MODEL_REPO,
} from "../src/shared/modelPresets";

const require = createRequire(import.meta.url);
const { calculateMtpFitCorrection, shouldCalibrateMtpFit } =
  require("../src/main/runtime/model/mtp-fit-calibration.cjs") as {
    calculateMtpFitCorrection: (input: {
      requestedFitTargetMiB: number;
      observedFreeMiB: number;
    }) => {
      correctionMiB: number;
      effectiveFitTargetMiB: number;
    };
    shouldCalibrateMtpFit: (
      options: Record<string, unknown>,
      platform?: NodeJS.Platform,
    ) => boolean;
  };

describe("MTP fit calibration", () => {
  it("adds the measured shortfall plus a 128 MiB safety margin in layer-sized 512 MiB steps", () => {
    expect(
      calculateMtpFitCorrection({
        requestedFitTargetMiB: 1024,
        observedFreeMiB: 646,
      }),
    ).toMatchObject({
      correctionMiB: 512,
      effectiveFitTargetMiB: 1536,
    });

    expect(
      calculateMtpFitCorrection({
        requestedFitTargetMiB: 1024,
        observedFreeMiB: 631,
      }),
    ).toMatchObject({
      correctionMiB: 512,
      effectiveFitTargetMiB: 1536,
    });

    expect(
      calculateMtpFitCorrection({
        requestedFitTargetMiB: 512,
        observedFreeMiB: 430,
      }),
    ).toMatchObject({
      correctionMiB: 512,
      effectiveFitTargetMiB: 1024,
    });
  });

  it("accepts arbitrary integer MiB targets without forcing powers of two", () => {
    expect(
      calculateMtpFitCorrection({
        requestedFitTargetMiB: 1153,
        observedFreeMiB: 1300,
      }),
    ).toMatchObject({
      correctionMiB: 0,
      effectiveFitTargetMiB: 1153,
    });
  });

  it("only calibrates built-in QAT MTP speed models on Windows CUDA", () => {
    const speed = {
      modelRepo: GEMMA_12B_QAT_MODEL_REPO,
      modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
      llamaRuntimeProfile: "cuda12",
      useDraft: true,
      draftSpecType: "draft-mtp",
      gpuLayers: "fit",
    };
    expect(shouldCalibrateMtpFit(speed, "win32")).toBe(true);
    expect(
      shouldCalibrateMtpFit(
        { ...speed, fitEnabled: false, gpuLayers: "all" },
        "win32",
      ),
    ).toBe(false);
    expect(
      shouldCalibrateMtpFit(
        { ...speed, llamaRuntimeProfile: "vulkan" },
        "win32",
      ),
    ).toBe(false);
    expect(shouldCalibrateMtpFit(speed, "darwin")).toBe(false);
    expect(
      shouldCalibrateMtpFit(
        {
          ...speed,
          modelRepo: GEMMA_12B_MODEL_REPO,
          modelFile: GEMMA_12B_MODEL_FILE_Q4_K_M,
        },
        "win32",
      ),
    ).toBe(false);
  });
});
