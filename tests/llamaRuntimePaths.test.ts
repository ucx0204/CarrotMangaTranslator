import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { inferAmdRocmTargetFromText } = require("../src/main/runtime/simple-page-amd-rocm-target.cjs") as {
  inferAmdRocmTargetFromText: (value: string) => string | null;
};
const { collectSelectedFiles } = require("../src/main/runtime/simple-page-zip-utils.cjs") as {
  collectSelectedFiles: (
    rootDir: string,
    shouldExtract: (fileName: string, relativePath?: string) => boolean
  ) => Array<{ filePath: string; outputName: string }>;
};
const {
  hasRequiredLlamaRuntimeFiles,
  missingRequiredLlamaRuntimeFiles,
  resolvePreferredLlamaRuntime
} = require("../src/main/runtime/simple-page-runtime-paths.cjs") as {
  hasRequiredLlamaRuntimeFiles: (runtimeDir: string, runtime: Record<string, unknown>) => boolean;
  missingRequiredLlamaRuntimeFiles: (runtimeDir: string, runtime: Record<string, unknown>) => string[];
  resolvePreferredLlamaRuntime: (options?: Record<string, unknown>) => {
    id: string;
    dir: string;
    archive: string;
    url: string;
    backend: string;
  };
};

describe("llama runtime path selection", () => {
  it("infers Azure AMD Radeon PRO V710 style hardware text as gfx110X", () => {
    expect(inferAmdRocmTargetFromText("AMD Radeon PRO V710 MxGPU VEN_1002&DEV_7460")).toBe("gfx110X");
    expect(inferAmdRocmTargetFromText("AMD Radeon PRO V710-8Q")).toBe("gfx110X");
  });

  it("selects the matching Lemonade ROCm runtime for a known AMD target", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx1201"
    });

    expect(runtime.backend).toBe("rocm");
    expect(runtime.id).toBe("lemonade-llama-b1291-rocm-gfx120X");
    expect(runtime.dir).toBe("lemonade-llama-b1291-rocm-gfx120X");
    expect(runtime.archive).toBe("llama-b1291-windows-rocm-gfx120X-x64.zip");
    expect(runtime.url).toContain("lemonade-sdk/llamacpp-rocm/releases/download/b1291/");
  });

  it("accepts ROCm 7 HIP runtime DLL names from Lemonade archives", () => {
    const runtime = resolvePreferredLlamaRuntime({
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X"
    });
    const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-rocm-runtime-"));
    try {
      const rocblasDir = join(runtimeDir, "rocblas", "library");
      const hipblasltDir = join(runtimeDir, "hipblaslt", "library");
      mkdirSync(rocblasDir, { recursive: true });
      mkdirSync(hipblasltDir, { recursive: true });
      for (const fileName of ["llama-server.exe", "llama-server-impl.dll", "ggml-hip.dll", "amdhip64_7.dll"]) {
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
      llamaRocmTarget: "gfx110X"
    });
    const runtimeDir = mkdtempSync(join(tmpdir(), "mgt-rocm-runtime-missing-kernels-"));
    try {
      for (const fileName of ["llama-server.exe", "llama-server-impl.dll", "ggml-hip.dll", "amdhip64_7.dll"]) {
        writeFileSync(join(runtimeDir, fileName), "");
      }

      expect(hasRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toBe(false);
      expect(missingRequiredLlamaRuntimeFiles(runtimeDir, runtime)).toEqual(
        expect.arrayContaining([
          "rocblas/library/*.dat|*.co|*.hsaco",
          "hipblaslt/library/*.dat|*.co|*.hsaco"
        ])
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

      const selected = collectSelectedFiles(runtimeDir, (fileName, relativePath) => {
        const normalizedRelativePath = String(relativePath ?? fileName).replace(/\\/g, "/").toLowerCase();
        return (
          fileName.endsWith(".exe") ||
          fileName.endsWith(".dll") ||
          ((normalizedRelativePath.startsWith("rocblas/") || normalizedRelativePath.startsWith("hipblaslt/")) &&
            /\.(?:dat|co|hsaco)$/i.test(normalizedRelativePath))
        );
      });

      expect(selected.map((entry) => entry.outputName).sort()).toEqual([
        "amdhip64_7.dll",
        join("hipblaslt", "library", "Kernels.so-000-gfx1101.hsaco"),
        "llama-server.exe",
        join("rocblas", "library", "TensileLibrary_gfx1101.dat")
      ]);
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it("does not guess an AMD ROCm runtime when the GPU target is unknown", () => {
    expect(() => resolvePreferredLlamaRuntime({ llamaRuntimeProfile: "rocm" })).toThrow(/AMD GPU/);
  });
});
