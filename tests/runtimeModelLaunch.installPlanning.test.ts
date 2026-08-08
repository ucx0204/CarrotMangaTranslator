import { describe, it, expect } from "vitest";
import {
  isGpuOutOfMemoryText,
  isGpuDeviceLostOrTdrText,
  isRocmHipAccessViolationText,
  buildPaddleOcrGpuFailureMessage,
  parseOcrBatchProgressLine,
  createTempDir,
  withOcrBatchPipelineStubs,
  buildOcrPipBuildToolUpgradeCommand,
  resolveOcrPipInstallExtraArgs,
  buildOcrPipInstallCommand,
  resolveOcrPipInstallBatches,
  resolveIntegrityPinnedOcrInstallBatches,
  summarizeOcrInstallBatches,
  resolveOcrInstallBatchLabel,
  resolveOcrRuntimeDir,
  resolveOcrPythonPackageDir,
  resolveOcrTempDir,
  resolveOcrPipCacheDir,
  resolveOcrPythonUserBaseDir,
  resolveOcrVenvDir,
  resolveOcrRuntimeVariant,
  isWindowsRocmOcrRuntimePathShortEnough,
  restoreEnv,
  buildOcrRuntimeEnv,
} from "./helpers/runtimeModelContracts";
import { join } from "node:path";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows(
  "runtime model support helpers: failure handling and install planning",
  () => {
    it("classifies GPU OCR failures for actionable Korean guidance", () => {
      expect(isGpuOutOfMemoryText("hipErrorOutOfMemory: out of memory")).toBe(
        true,
      );
      expect(isGpuOutOfMemoryText("torch.cuda.OutOfMemoryError")).toBe(true);
      expect(isGpuOutOfMemoryText("dll load failed")).toBe(false);
      expect(isGpuDeviceLostOrTdrText("hipErrorDeviceLost")).toBe(true);
      expect(
        isGpuDeviceLostOrTdrText("the launch timed out and was terminated"),
      ).toBe(true);
      expect(isGpuDeviceLostOrTdrText("out of memory")).toBe(false);
      expect(
        isRocmHipAccessViolationText(
          "Windows fatal exception: access violation in amdhip64_7.dll",
        ),
      ).toBe(true);
      expect(isRocmHipAccessViolationText("exit code 0xc0000005")).toBe(true);
      expect(isRocmHipAccessViolationText("out of memory")).toBe(false);

      const rocmOptions = {
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
      };
      expect(
        buildPaddleOcrGpuFailureMessage(
          new Error("hipErrorOutOfMemory"),
          rocmOptions,
        ),
      ).toContain("VRAM");
      expect(
        buildPaddleOcrGpuFailureMessage(
          new Error("access violation amdhip64_7.dll"),
          rocmOptions,
        ),
      ).toContain("iGPU");
      expect(
        buildPaddleOcrGpuFailureMessage(
          new Error("hipErrorDeviceLost"),
          rocmOptions,
        ),
      ).toContain("TDR");
      expect(
        buildPaddleOcrGpuFailureMessage(
          new Error("something odd"),
          rocmOptions,
        ),
      ).toContain("AMD OCR GPU 실행에 실패했습니다");
    });

    it("parses the error phase from OCR batch progress lines", () => {
      expect(
        parseOcrBatchProgressLine(
          JSON.stringify({ phase: "error", index: 2, total: 3, count: 0 }),
        ),
      ).toMatchObject({ phase: "error", index: 2, total: 3, count: 0 });
      expect(
        parseOcrBatchProgressLine(
          JSON.stringify({ phase: "done", index: 2, total: 3, count: 4 }),
        ),
      ).toMatchObject({ phase: "done" });
    });

    it("stops a failed GPU OCR batch instead of retrying on CPU by default", async () => {
      const outputDir = createTempDir("ocr-gpu-strict-");
      let commandIndex = 0;

      await withOcrBatchPipelineStubs(
        {
          ensurePaddleOcrRuntime() {
            return {
              pythonPath: "python",
              runtimeDir: join(outputDir, "runtime"),
              prepared: true,
              diagnostics: [],
            };
          },
          buildOcrBboxBatchCommand() {
            commandIndex += 1;
            return {
              executable: process.execPath,
              args: [`ocr-gpu-strict-${commandIndex}`],
            };
          },
          async runCommand() {
            throw new Error("hipErrorOutOfMemory: HIP out of memory");
          },
        },
        async (pipeline) => {
          expect(pipeline).not.toHaveProperty("buildCpuFallbackOcrOptions");
          expect(pipeline).not.toHaveProperty(
            "canFallBackToCpuAfterGpuFailure",
          );
          await expect(
            pipeline.collectOcrBboxHintsBatch([
              {
                imagePath: join(outputDir, "page-1.png"),
                outputDir: join(outputDir, "page-1"),
                imageWidth: 100,
                imageHeight: 100,
                ocrBboxProvider: "paddleocr-vl",
                ocrDevice: "gpu",
                ocrGpuBackend: "rocm-transformers",
                ocrCpuWorkers: 1,
              },
            ]),
          ).rejects.toThrow("VRAM");
        },
      );

      expect(commandIndex).toBe(1);
    });

    it("prepares build tooling before OCR package installs", () => {
      const command = buildOcrPipBuildToolUpgradeCommand(
        "C:/Python/python.exe",
        ["--cache-dir", "C:/ocr/pip-cache", "--progress-bar", "raw"],
      );

      expect(command.executable).toBe("C:/Python/python.exe");
      expect(command.args).toEqual([
        "-m",
        "pip",
        "install",
        "--cache-dir",
        "C:/ocr/pip-cache",
        "--progress-bar",
        "raw",
        "--require-hashes",
        "--only-binary=:all:",
        "--no-deps",
        "--requirement",
        expect.stringMatching(/requirements-build-tools\.lock$/),
      ]);
    });

    it("installs built-in Windows OCR runtimes from hash-complete locks", () => {
      const cpuBatches = resolveIntegrityPinnedOcrInstallBatches(
        resolveOcrPipInstallBatches({ ocrDevice: "cpu" }),
        { ocrDevice: "cpu" },
      );
      expect(cpuBatches).toHaveLength(2);
      expect(cpuBatches[0]).toEqual(
        expect.arrayContaining([
          "--require-hashes",
          "--only-binary=:all:",
          "--requirement",
          expect.stringMatching(/requirements-ocr-cpu-win-py312\.lock$/),
        ]),
      );
      expect(cpuBatches[1]).toEqual(
        expect.arrayContaining([
          "--require-hashes",
          "--no-deps",
          expect.stringMatching(/requirements-ocr-safetensors-win\.lock$/),
        ]),
      );

      const original = process.env.MANGA_TRANSLATOR_OCR_CPU_PIP_PACKAGES;
      process.env.MANGA_TRANSLATOR_OCR_CPU_PIP_PACKAGES = "paddlepaddle";
      try {
        expect(() =>
          resolveIntegrityPinnedOcrInstallBatches([["paddlepaddle"]], {
            ocrDevice: "cpu",
          }),
        ).toThrow("requires MGT_OCR_REQUIREMENTS_LOCK");
      } finally {
        restoreEnv("MANGA_TRANSLATOR_OCR_CPU_PIP_PACKAGES", original);
      }
    });

    it("uses no build isolation for ROCm meta packages and no deps for ROCm resolver traps", () => {
      const rocmMetaPackage = [
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz",
      ];
      const rocmWheels = [
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl",
      ];
      const torchDeps = [
        "filelock",
        "typing-extensions>=4.10.0",
        "setuptools",
        "sympy>=1.13.3",
        "networkx>=2.5.1",
        "jinja2",
        "fsspec>=0.8.5",
        "numpy",
        "pillow",
      ];
      const rocmTorchWheels = [
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchaudio-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
        "https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torchvision-0.24.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl",
      ];
      const paddleOcrPackages = [
        "paddleocr==3.7.0",
        "transformers==5.13.1",
        "safetensors>=0.6.2",
      ];
      const options = {
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
      };
      const rocmMetaExtraArgs = resolveOcrPipInstallExtraArgs(
        rocmMetaPackage,
        options,
      );
      const rocmMetaCommand = buildOcrPipInstallCommand(
        "C:/Python/python.exe",
        rocmMetaPackage,
        "C:/ocr/p",
        options,
        ["--cache-dir", "C:/ocr/c", "--progress-bar", "raw"],
      );
      const rocmTorchCommand = buildOcrPipInstallCommand(
        "C:/Python/python.exe",
        rocmTorchWheels,
        "C:/ocr/p",
        options,
        ["--cache-dir", "C:/ocr/c", "--progress-bar", "raw"],
      );

      expect(rocmMetaExtraArgs).toContain("--no-build-isolation");
      expect(rocmMetaExtraArgs).toContain("--no-deps");
      expect(resolveOcrPipInstallExtraArgs(rocmWheels, options)).toEqual([]);
      expect(resolveOcrPipInstallExtraArgs(torchDeps, options)).toEqual([]);
      expect(resolveOcrPipInstallExtraArgs(rocmTorchWheels, options)).toEqual([
        "--no-deps",
      ]);
      expect(resolveOcrPipInstallExtraArgs(paddleOcrPackages, options)).toEqual(
        [],
      );
      expect(rocmMetaCommand.args).toContain("--no-build-isolation");
      expect(rocmMetaCommand.args).toContain("--no-deps");
      expect(rocmMetaCommand.args).toContain("--target");
      expect(rocmMetaCommand.args).toContain("C:/ocr/p");
      expect(rocmTorchCommand.args).toContain("--no-deps");
      expect(rocmTorchCommand.args).not.toContain("--no-build-isolation");
    });

    it("labels AMD ROCm URL-only install batches", () => {
      const options = {
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
      };
      const rocmBatches = resolveOcrPipInstallBatches(options);
      const summary = summarizeOcrInstallBatches(rocmBatches, options);

      expect(resolveOcrInstallBatchLabel(rocmBatches[0], options)).toBe(
        "AMD ROCm SDK wheels",
      );
      expect(resolveOcrInstallBatchLabel(rocmBatches[1], options)).toBe(
        "AMD ROCm meta package",
      );
      expect(resolveOcrInstallBatchLabel(rocmBatches[2], options)).toBe(
        "PyTorch Python dependencies",
      );
      expect(resolveOcrInstallBatchLabel(rocmBatches[3], options)).toBe(
        "PyTorch ROCm wheels",
      );
      expect(resolveOcrInstallBatchLabel(rocmBatches[4], options)).toBe(
        "PaddleOCR Transformers packages",
      );
      expect(summary).toContain("AMD ROCm SDK wheels");
      expect(summary).toContain("AMD ROCm meta package");
      expect(summary).toContain("PyTorch Python dependencies");
      expect(summary).toContain("PyTorch ROCm wheels");
      expect(summary).toContain("PaddleOCR Transformers packages");
    });

    it("uses a short Windows runtime layout for AMD ROCm OCR installs", () => {
      if (process.platform !== "win32") {
        return;
      }
      const previousLocalAppData = process.env.LOCALAPPDATA;
      const previousRuntimeDir = process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR;
      const previousRocmRuntimeDir =
        process.env.MANGA_TRANSLATOR_OCR_ROCM_RUNTIME_DIR;
      const previousShortRocmRuntimeDir = process.env.MGT_OCR_ROCM_RUNTIME_DIR;
      delete process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR;
      delete process.env.MANGA_TRANSLATOR_OCR_ROCM_RUNTIME_DIR;
      delete process.env.MGT_OCR_ROCM_RUNTIME_DIR;
      process.env.LOCALAPPDATA = "C:\\Users\\taepotaepo\\AppData\\Local";
      try {
        const oldRuntimeDir =
          "C:\\Users\\taepotaepo\\AppData\\Local\\Programs\\manga-gemma-translator\\data\\ocr-runtime";
        const options = {
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
          ocrRuntimeDir: oldRuntimeDir,
        };
        const runtimeDir = resolveOcrRuntimeDir(options);
        const packageDir = resolveOcrPythonPackageDir(runtimeDir, options);
        const tempDir = resolveOcrTempDir(runtimeDir, options);
        const pipCacheDir = resolveOcrPipCacheDir(runtimeDir, options);
        const userBaseDir = resolveOcrPythonUserBaseDir(runtimeDir, options);
        const venvDir = resolveOcrVenvDir(
          runtimeDir,
          resolveOcrRuntimeVariant(options),
          options,
        );
        const longPipTempEntry = join(
          runtimeDir,
          "t",
          "pip-target-wnkr20fe",
          "lib",
          "python",
          "_rocm_sdk_libraries_custom",
          "bin",
          "hipblaslt",
          "library",
          "TensileLibrary_B8B8_B8B8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.co",
        );

        expect(isWindowsRocmOcrRuntimePathShortEnough(oldRuntimeDir)).toBe(
          false,
        );
        expect(runtimeDir).toBe(
          join("C:\\Users\\taepotaepo\\AppData\\Local", "MGTOCR", "r721"),
        );
        expect(packageDir).toBe(join(runtimeDir, "p"));
        expect(tempDir).toBe(join(runtimeDir, "t"));
        expect(pipCacheDir).toBe(join(runtimeDir, "c"));
        expect(userBaseDir).toBe(join(runtimeDir, "u"));
        expect(venvDir).toBe(join(runtimeDir, "v"));
        expect(longPipTempEntry.length).toBeLessThan(252);
        expect(packageDir).not.toContain(
          "python-packages-gpu-rocm-transformers",
        );
      } finally {
        restoreEnv("LOCALAPPDATA", previousLocalAppData);
        restoreEnv("MANGA_TRANSLATOR_OCR_RUNTIME_DIR", previousRuntimeDir);
        restoreEnv(
          "MANGA_TRANSLATOR_OCR_ROCM_RUNTIME_DIR",
          previousRocmRuntimeDir,
        );
        restoreEnv("MGT_OCR_ROCM_RUNTIME_DIR", previousShortRocmRuntimeDir);
      }
    });

    it("keeps CPU and NVIDIA OCR runtime layouts unchanged", () => {
      const runtimeDir = createTempDir("ocr-runtime-");

      expect(
        resolveOcrRuntimeDir({ ocrDevice: "cpu", ocrRuntimeDir: runtimeDir }),
      ).toBe(runtimeDir);
      expect(
        resolveOcrRuntimeDir({
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
          ocrRuntimeDir: runtimeDir,
        }),
      ).toBe(runtimeDir);
      expect(resolveOcrPythonPackageDir(runtimeDir, { ocrDevice: "cpu" })).toBe(
        join(runtimeDir, "python-packages-cpu"),
      );
      expect(
        resolveOcrPythonPackageDir(runtimeDir, {
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
          ocrGpuCudaTag: "cu126",
        }),
      ).toBe(join(runtimeDir, "python-packages-gpu-cu126"));
      expect(resolveOcrTempDir(runtimeDir, { ocrDevice: "cpu" })).toBe(
        join(runtimeDir, "tmp"),
      );
      expect(resolveOcrPipCacheDir(runtimeDir, { ocrDevice: "cpu" })).toBe(
        join(runtimeDir, "pip-cache"),
      );
    });

    it("uses short ROCm OCR dirs in the Python runtime environment and pip target", () => {
      if (process.platform !== "win32") {
        return;
      }
      const runtimeDir = join(
        "C:\\Users\\taepotaepo\\AppData\\Local",
        "MGTOCR",
        "r721",
      );
      const options = {
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
        ocrRuntimeDir: runtimeDir,
      };
      const packageDir = resolveOcrPythonPackageDir(runtimeDir, options);
      const env = buildOcrRuntimeEnv(options, {
        runtimeDir,
        packageDir,
        includePackageDir: true,
      });
      const command = buildOcrPipInstallCommand(
        "C:/Python/python.exe",
        resolveOcrPipInstallBatches(options)[0],
        packageDir,
        options,
        ["--cache-dir", join(runtimeDir, "c"), "--progress-bar", "raw"],
      );

      expect(env.TMP).toBe(join(runtimeDir, "t"));
      expect(env.TEMP).toBe(join(runtimeDir, "t"));
      expect(env.TMPDIR).toBe(join(runtimeDir, "t"));
      expect(env.PIP_CACHE_DIR).toBe(join(runtimeDir, "c"));
      expect(env.PYTHONUSERBASE).toBe(join(runtimeDir, "u"));
      expect(env.PYTHONPATH).toBe(packageDir);
      expect(command.args).toContain("--target");
      expect(command.args).toContain(packageDir);
      expect(command.args.join(" ")).not.toContain("data\\ocr-runtime");
      expect(command.args.join(" ")).not.toContain(
        "python-packages-gpu-rocm-transformers",
      );
    });

    it("allows explicit AMD ROCm OCR runtime directory overrides", () => {
      if (process.platform !== "win32") {
        return;
      }
      const previousGlobal = process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR;
      const previousRocm = process.env.MANGA_TRANSLATOR_OCR_ROCM_RUNTIME_DIR;
      try {
        process.env.MANGA_TRANSLATOR_OCR_ROCM_RUNTIME_DIR = "R:\\MGTOCR\\r721";
        delete process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR;
        expect(
          resolveOcrRuntimeDir({
            ocrDevice: "gpu",
            ocrGpuBackend: "rocm-transformers",
          }),
        ).toBe("R:\\MGTOCR\\r721");

        process.env.MANGA_TRANSLATOR_OCR_RUNTIME_DIR = "S:\\GlobalOCR";
        expect(
          resolveOcrRuntimeDir({
            ocrDevice: "gpu",
            ocrGpuBackend: "rocm-transformers",
          }),
        ).toBe("S:\\GlobalOCR");
      } finally {
        restoreEnv("MANGA_TRANSLATOR_OCR_RUNTIME_DIR", previousGlobal);
        restoreEnv("MANGA_TRANSLATOR_OCR_ROCM_RUNTIME_DIR", previousRocm);
      }
    });
  },
);

describe("runtime model support helpers: portable temporary directories", () => {
  it("sets TMPDIR together with TEMP and TMP for OCR child processes", () => {
    const runtimeDir = createTempDir("ocr-portable-temp-");
    const expected = resolveOcrTempDir(runtimeDir, { ocrDevice: "cpu" });
    const env = buildOcrRuntimeEnv(
      { ocrDevice: "cpu", ocrRuntimeDir: runtimeDir },
      { runtimeDir, includePackageDir: false },
    );

    expect(env.TEMP).toBe(expected);
    expect(env.TMP).toBe(expected);
    expect(env.TMPDIR).toBe(expected);
  });
});
