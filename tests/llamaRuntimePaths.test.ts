import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
} from "../src/shared/modelPresets";

const require = createRequire(import.meta.url);
const AdmZip = require("adm-zip") as {
  new (): {
    addFile: (name: string, data: Buffer) => void;
    writeZip: (path: string) => void;
  };
};
const { inferAmdRocmTargetFromText } =
  require("../src/main/runtime/simple-page-amd-rocm-target.cjs") as {
    inferAmdRocmTargetFromText: (value: string) => string | null;
  };
const { collectSelectedFiles, extractSelectedZipEntries } =
  require("../src/main/runtime/simple-page-zip-utils.cjs") as {
    collectSelectedFiles: (
      rootDir: string,
      shouldExtract: (fileName: string, relativePath?: string) => boolean,
    ) => Array<{ filePath: string; outputName: string }>;
    extractSelectedZipEntries: (
      archivePath: string,
      outputDir: string,
      shouldExtract: (fileName: string, relativePath: string) => boolean,
    ) => Promise<void>;
  };
const {
  hasRequiredLlamaRuntimeFiles,
  missingRequiredLlamaRuntimeFiles,
  resolvePreferredLlamaRuntime,
} = require("../src/main/runtime/simple-page-runtime-paths.cjs") as {
  hasRequiredLlamaRuntimeFiles: (
    runtimeDir: string,
    runtime: Record<string, unknown>,
  ) => boolean;
  missingRequiredLlamaRuntimeFiles: (
    runtimeDir: string,
    runtime: Record<string, unknown>,
  ) => string[];
  resolvePreferredLlamaRuntime: (options?: Record<string, unknown>) => {
    id: string;
    dir: string;
    archive: string;
    url: string;
    backend: string;
  };
};
const { resolveLlamaRuntimePreflightTimeoutMs } =
  require("../src/main/runtime/simple-page-server-lifecycle.cjs") as {
    resolveLlamaRuntimePreflightTimeoutMs: (
      runtime?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => number;
  };

describe("llama runtime path selection", () => {
  it("infers Azure AMD Radeon PRO V710 style hardware text as gfx110X", () => {
    expect(
      inferAmdRocmTargetFromText("AMD Radeon PRO V710 MxGPU VEN_1002&DEV_7460"),
    ).toBe("gfx110X");
    expect(inferAmdRocmTargetFromText("AMD Radeon PRO V710-8Q")).toBe(
      "gfx110X",
    );
  });

  it("selects the matching Lemonade ROCm runtime for a known AMD target", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx1201",
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    });

    expect(runtime.backend).toBe("rocm");
    expect(runtime.id).toBe("lemonade-llama-b1291-rocm-gfx120X");
    expect(runtime.dir).toBe("lemonade-llama-b1291-rocm-gfx120X");
    expect(runtime.archive).toBe("llama-b1291-windows-rocm-gfx120X-x64.zip");
    expect(runtime.url).toContain(
      "lemonade-sdk/llamacpp-rocm/releases/download/b1291/",
    );
  });

  it("selects BeeLlama HIP Radeon for the 31B ROCm DFlash preset", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: DEFAULT_GEMMA_MODEL_REPO,
      modelFile: DEFAULT_GEMMA_MODEL_FILE,
    });

    expect(runtime.backend).toBe("rocm");
    expect(runtime.id).toBe("beellama-v0.3.1-hip-radeon");
    expect(runtime.dir).toBe("beellama-v0.3.1-hip-radeon");
    expect(runtime.archive).toBe("beellama-v0.3.1-bin-win-hip-radeon-x64.zip");
    expect(runtime.url).toBe(
      "https://github.com/Anbeeld/beellama.cpp/releases/download/v0.3.1/beellama-v0.3.1-bin-win-hip-radeon-x64.zip",
    );
  });

  it("does not require a target-specific Lemonade archive for 31B ROCm DFlash", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      modelRepo: DEFAULT_GEMMA_MODEL_REPO,
      modelFile: DEFAULT_GEMMA_MODEL_FILE,
      disableHostRocmTargetDetection: true,
    });

    expect(runtime.id).toBe("beellama-v0.3.1-hip-radeon");
    expect(runtime.archive).toBe("beellama-v0.3.1-bin-win-hip-radeon-x64.zip");
  });

  it("accepts BeeLlama HIP Radeon runtime files for DFlash", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: DEFAULT_GEMMA_MODEL_REPO,
      modelFile: DEFAULT_GEMMA_MODEL_FILE,
    });
    const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-beellama-hip-"));
    try {
      const rocblasDir = join(runtimeDir, "rocblas", "library");
      const hipblasltDir = join(runtimeDir, "hipblaslt", "library");
      mkdirSync(rocblasDir, { recursive: true });
      mkdirSync(hipblasltDir, { recursive: true });
      for (const fileName of [
        "llama-server.exe",
        "llama-server-impl.dll",
        "llama.dll",
        "ggml-hip.dll",
        "rocblas.dll",
        "libhipblas.dll",
        "libhipblaslt.dll",
      ]) {
        writeFileSync(join(runtimeDir, fileName), "");
      }
      writeFileSync(join(rocblasDir, "TensileLibrary_Type_HH_gfx1101.dat"), "");
      writeFileSync(join(hipblasltDir, "Kernels.so-000-gfx1101.hsaco"), "");

      expect(missingRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toEqual([]);
      expect(hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toBe(true);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("accepts ROCm 7 HIP runtime DLL names from Lemonade archives", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    });
    const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-rocm-runtime-"));
    try {
      const rocblasDir = join(runtimeDir, "rocblas", "library");
      const hipblasltDir = join(runtimeDir, "hipblaslt", "library");
      mkdirSync(rocblasDir, { recursive: true });
      mkdirSync(hipblasltDir, { recursive: true });
      for (const fileName of [
        "llama-server.exe",
        "llama-server-impl.dll",
        "ggml-hip.dll",
        "amdhip64_7.dll",
      ]) {
        writeFileSync(join(runtimeDir, fileName), "");
      }
      writeFileSync(join(rocblasDir, "TensileLibrary_Type_HH_gfx1101.dat"), "");
      writeFileSync(join(hipblasltDir, "Kernels.so-000-gfx1101.hsaco"), "");

      expect(missingRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toEqual([]);
      expect(hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toBe(true);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("rejects ROCm runtimes that are missing extracted kernel libraries", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
    });
    const runtimeDir = mkdtempSync(
      join(tmpdir(), "mgt-rocm-runtime-missing-kernels-"),
    );
    try {
      for (const fileName of [
        "llama-server.exe",
        "llama-server-impl.dll",
        "ggml-hip.dll",
        "amdhip64_7.dll",
      ]) {
        writeFileSync(join(runtimeDir, fileName), "");
      }

      expect(hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toBe(false);
      expect(missingRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toEqual(
        expect.arrayContaining([
          "rocblas/library/*.dat|*.co|*.hsaco",
          "hipblaslt/library/*.dat|*.co|*.hsaco",
        ]),
      );
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("preserves ROCm kernel library directories when selecting runtime files", () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-rocm-select-"));
    try {
      const rocblasDir = join(runtimeDir, "rocblas", "library");
      const hipblasltDir = join(runtimeDir, "hipblaslt", "library");
      mkdirSync(rocblasDir, { recursive: true });
      mkdirSync(hipblasltDir, { recursive: true });
      writeFileSync(join(runtimeDir, "llama-server.exe"), "");
      writeFileSync(join(runtimeDir, "amdhip64_7.dll"), "");
      writeFileSync(join(rocblasDir, "TensileLibrary_gfx1101.dat"), "");
      writeFileSync(join(hipblasltDir, "Kernels.so-000-gfx1101.hsaco"), "");

      const selected = collectSelectedFiles(
        runtimeDir,
        (fileName, relativePath) => {
          const normalizedRelativePath = String(relativePath ?? fileName)
            .replace(/\\/g, "/")
            .toLowerCase();
          return (
            fileName.endsWith(".exe") ||
            fileName.endsWith(".dll") ||
            ((normalizedRelativePath.startsWith("rocblas/") ||
              normalizedRelativePath.startsWith("hipblaslt/")) &&
              /\.(?:dat|co|hsaco)$/i.test(normalizedRelativePath))
          );
        },
      );

      expect(selected.map((entry) => entry.outputName).sort()).toEqual([
        "amdhip64_7.dll",
        join("hipblaslt", "library", "Kernels.so-000-gfx1101.hsaco"),
        "llama-server.exe",
        join("rocblas", "library", "TensileLibrary_gfx1101.dat"),
      ]);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("includes extraction diagnostics when no runtime files match", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const tempDir = mkdtempSync(join(tmpdir(), "mgt-runtime-zip-empty-"));
    try {
      const archivePath = join(tempDir, "runtime.zip");
      const outputDir = join(tempDir, "runtime");
      mkdirSync(outputDir, { recursive: true });
      const zip = new AdmZip();
      zip.addFile("docs/readme.txt", Buffer.from("no runtime files here"));
      zip.writeZip(archivePath);

      let caught: unknown;
      try {
        await extractSelectedZipEntries(archivePath, outputDir, () => false);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("No runtime files matched");
      expect(caught).toMatchObject({
        archivePath,
        extractionMethod: expect.stringMatching(/^(powershell|tar)$/),
        extractedTopLevelEntries: ["docs/"],
      });
      expect(
        Array.isArray(
          (caught as { extractionAttempts?: unknown }).extractionAttempts,
        ),
      ).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not guess an AMD ROCm runtime when the GPU target is unknown", () => {
    expect(() =>
      resolvePreferredLlamaRuntime({
        llamaRuntimeProfile: "rocm",
        modelRepo: GEMMA_26B_MODEL_REPO,
        modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
        disableHostRocmTargetDetection: true,
      }),
    ).toThrow(/AMD GPU/);
  });

  it("gives ROCm/HIP runtime probes enough time for first-load initialization", () => {
    expect(
      resolveLlamaRuntimePreflightTimeoutMs({ backend: "rocm" }),
    ).toBeGreaterThanOrEqual(120000);
    expect(
      resolveLlamaRuntimePreflightTimeoutMs({ backend: "hip" }),
    ).toBeGreaterThanOrEqual(120000);
    expect(resolveLlamaRuntimePreflightTimeoutMs({ backend: "vulkan" })).toBe(
      20000,
    );
    expect(
      resolveLlamaRuntimePreflightTimeoutMs(
        { backend: "rocm" },
        { llamaRuntimePreflightTimeoutMs: 45000 },
      ),
    ).toBe(45000);
  });
});
