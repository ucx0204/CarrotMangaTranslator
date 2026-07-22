import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOcrGpuBackend as resolveStoredOcrGpuBackend } from "../src/main/settings/appSettingsResolvers";
import { resolveHardwareDefaults } from "../src/main/settings/hardwareDefaults";

const runtimeConfig =
  require("../src/main/runtime/simple-page-ocr-runtime-config.cjs") as {
    buildOcrRuntimeEnv: (options: Record<string, unknown>) => NodeJS.ProcessEnv;
    buildPaddleOcrGpuFailureMessage: (
      error: unknown,
      options: Record<string, unknown>,
    ) => string;
    buildPaddleOcrImportCheckScript: (
      options: Record<string, unknown>,
    ) => string;
    resolveEffectiveOcrDevice: (options: Record<string, unknown>) => string;
    resolveOcrGpuBackend: (options: Record<string, unknown>) => string;
    resolveOcrRuntimeVariant: (options: Record<string, unknown>) => string;
  };

const { hasExpectedOcrPackages } =
  require("../src/main/runtime/ocr/runtime-verification.cjs") as {
    hasExpectedOcrPackages: (
      packageDir: string,
      options: Record<string, unknown>,
    ) => boolean;
  };

describe("Apple MLX PaddleOCR-VL support", () => {
  it("selects full-load MLX OCR on a 32 GB Apple Silicon machine", () => {
    expect(
      resolveHardwareDefaults({
        name: "Apple M2 Max",
        memoryMb: 32 * 1024,
        unifiedMemoryMb: 32 * 1024,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "apple",
        supportsMetal: true,
      }),
    ).toMatchObject({
      ocrDevice: "gpu",
      ocrGpuBackend: "mlx-vlm",
      ocrQualityMode: "full",
      llamaRuntimeProfile: "metal",
    });
  });

  it("keeps Paddle layout on CPU while selecting MLX for VL recognition", () => {
    const options = { ocrDevice: "gpu", ocrGpuBackend: "mlx-vlm" };
    const env = runtimeConfig.buildOcrRuntimeEnv(options);

    expect(resolveStoredOcrGpuBackend("metal")).toBe("mlx-vlm");
    expect(runtimeConfig.resolveOcrGpuBackend(options)).toBe("mlx-vlm");
    expect(runtimeConfig.resolveEffectiveOcrDevice(options)).toBe("cpu");
    expect(runtimeConfig.resolveOcrRuntimeVariant(options)).toBe("gpu-mlx-vlm");
    expect(env.MANGA_TRANSLATOR_OCR_DEVICE).toBe("gpu");
    expect(env.MANGA_TRANSLATOR_OCR_GPU_BACKEND).toBe("mlx-vlm");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE).toBe("cpu");
    expect(env.OMP_NUM_THREADS).toBe("2");
  });

  it("verifies MLX packages and returns Apple-specific failures", () => {
    const options = { ocrDevice: "gpu", ocrGpuBackend: "mlx-vlm" };
    const packageDir = mkdtempSync(join(tmpdir(), "carrot-mlx-packages-"));
    try {
      for (const name of ["paddle", "paddleocr", "paddlex", "mlx", "mlx_vlm"]) {
        mkdirSync(join(packageDir, name));
      }
      expect(hasExpectedOcrPackages(packageDir, options)).toBe(true);
      rmSync(join(packageDir, "mlx_vlm"), { recursive: true });
      expect(hasExpectedOcrPackages(packageDir, options)).toBe(false);

      const script = runtimeConfig.buildPaddleOcrImportCheckScript(options);
      expect(script).toContain("import mlx.core as mx");
      expect(script).toContain("import mlx_vlm.server");
      expect(script).toContain("mx.device_info()");
      expect(script).not.toContain("is_compiled_with_cuda");
      expect(
        runtimeConfig.buildPaddleOcrGpuFailureMessage(
          new Error("MLX Metal device unavailable"),
          options,
        ),
      ).toContain("Apple MLX OCR");
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });
});
