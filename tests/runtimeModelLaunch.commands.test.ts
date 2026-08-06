import { describe, it, expect } from "vitest";
import {
  buildOcrBboxCommand,
  buildOcrBboxBatchCommand,
  buildOcrRuntimeEnv,
  buildPaddleOcrImportCheckScript,
  buildPaddleOcrImportFailureMessage,
  isPaddleNativeDllLoadFailureText,
  resolveOcrPipInstallBatches,
  restoreEnv,
  DEFAULT_31B_REPO,
  DEFAULT_31B_FILE,
  DEFAULT_26B_REPO,
  DEFAULT_26B_FILE,
  resolvePaddleOcrImportCheckTimeoutMs,
} from "./helpers/runtimeModelContracts";
import { join, delimiter } from "node:path";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows(
  "runtime model support helpers: commands, native errors, and packages",
  () => {
    it("builds backend-specific OCR bbox commands", () => {
      const runtime = { pythonPath: "python" };
      const cpuCommand = buildOcrBboxCommand(
        { imagePath: "page.png", ocrDevice: "cpu" },
        "paddleocr-vl",
        "out.json",
        runtime,
      );
      const cudaCommand = buildOcrBboxBatchCommand(
        { ocrDevice: "gpu", ocrGpuBackend: "cuda" },
        "batch.json",
        runtime,
        "progress.jsonl",
      );
      const amdCommand = buildOcrBboxCommand(
        {
          imagePath: "page.png",
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
        },
        "paddleocr-vl",
        "out.json",
        runtime,
      );

      expect(cpuCommand.executable).toBe("python");
      expect(cudaCommand.executable).toBe("python");
      expect(amdCommand.executable).toBe("python");
      expect(cpuCommand.args).not.toContain("--bbox-mode");
      expect(cpuCommand.args).not.toContain("--engine");
      expect(cudaCommand.args).not.toContain("--bbox-mode");
      expect(cudaCommand.args).not.toContain("--engine");
      expect(amdCommand.args).toContain("--bbox-mode");
      expect(amdCommand.args).toContain("ocr");
      expect(amdCommand.args).toContain("--engine");
      expect(amdCommand.args).toContain("transformers");
      expect(amdCommand.args).toContain("--dtype");
      expect(amdCommand.args).toContain("float32");
      expect(amdCommand.args).toContain("--ocr-version");
      expect(amdCommand.args).toContain("PP-OCRv6");
      expect(amdCommand.args).toContain("--merge-mode");
      expect(amdCommand.args).toContain("semantic");
    });

    it("passes smoke OCR presets for economy and CUDA legacy full modes", () => {
      const runtime = { pythonPath: "python" };
      const economyCommand = buildOcrBboxCommand(
        {
          imagePath: "page.png",
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
          ocrBboxMode: "ocr",
          ocrEngine: "paddle_static",
          ocrEngineDtype: "float32",
          ocrVersion: "PP-OCRv6",
          ocrTextDetectionModelName: "PP-OCRv6_small_det",
          ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
          ocrMergeMode: "semantic",
          ocrDetLimit: "1600",
          ocrRecBatch: "1",
        },
        "paddleocr-vl",
        "out.json",
        runtime,
      );
      const fullCommand = buildOcrBboxCommand(
        {
          imagePath: "page.png",
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
          ocrBboxMode: "vl",
          ocrVersion: "PP-OCRv6",
          ocrMergeMode: "legacy",
          ocrDetLimit: "1600",
          ocrRecBatch: "1",
        },
        "paddleocr-vl",
        "out.json",
        runtime,
      );
      const env = buildOcrRuntimeEnv({
        ocrDevice: "gpu",
        ocrGpuBackend: "cuda",
        ocrBboxMode: "ocr",
        ocrEngine: "paddle_static",
        ocrTextDetectionModelName: "PP-OCRv6_small_det",
        ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
        ocrMergeMode: "semantic",
      });

      expect(economyCommand.args).toContain("--bbox-mode");
      expect(economyCommand.args).toContain("ocr");
      expect(economyCommand.args).toContain("--engine");
      expect(economyCommand.args).toContain("paddle_static");
      expect(economyCommand.args).toContain("--text-detection-model-name");
      expect(economyCommand.args).toContain("PP-OCRv6_small_det");
      expect(economyCommand.args).toContain("--text-recognition-model-name");
      expect(economyCommand.args).toContain("PP-OCRv6_small_rec");
      expect(economyCommand.args).toContain("--merge-mode");
      expect(economyCommand.args).toContain("semantic");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE).toBe("ocr");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBe("paddle_static");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME).toBe(
        "PP-OCRv6_small_det",
      );
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME).toBe(
        "PP-OCRv6_small_rec",
      );
      expect(fullCommand.args).toContain("--bbox-mode");
      expect(fullCommand.args).toContain("vl");
      expect(fullCommand.args).toContain("--ocr-version");
      expect(fullCommand.args).toContain("PP-OCRv6");
      expect(fullCommand.args).toContain("--merge-mode");
      expect(fullCommand.args).toContain("legacy");
      expect(fullCommand.args).not.toContain("--engine");
      expect(fullCommand.args).not.toContain("--text-detection-model-name");
      expect(fullCommand.args).not.toContain("--text-recognition-model-name");
    });

    it("adds Paddle native DLL directories for isolated Windows OCR runtimes", () => {
      const packageDir = join("C:/ocr-runtime", "python-packages-cpu");
      const paddleBaseDir = join(packageDir, "paddle", "base");
      const env = buildOcrRuntimeEnv(
        { ocrDevice: "cpu" },
        {
          runtimeDir: "C:/ocr-runtime",
          packageDir,
        },
      );
      const pathParts = String(env.PATH ?? "").split(delimiter);
      const dllParts = String(env.MANGA_TRANSLATOR_OCR_DLL_DIRS ?? "").split(
        delimiter,
      );
      const script = buildPaddleOcrImportCheckScript({ ocrDevice: "cpu" });

      expect(pathParts).toContain(paddleBaseDir);
      expect(dllParts).toContain(paddleBaseDir);
      expect(script).toContain("os.add_dll_directory");
      expect(script).toContain("import paddle");
      expect(script).toContain("from paddleocr import PaddleOCRVL, PaddleOCR");
      expect(script).not.toContain("import torch");
      expect(script).not.toContain("torch.version");
    });

    it("explains Paddle native DLL load failures separately from generic import errors", () => {
      const message = buildPaddleOcrImportFailureMessage(
        "Error: Can not import paddle core while this file exists: C:/ocr/python-packages-cpu/paddle/base/libpaddle.pyd\nImportError: DLL load failed while importing libpaddle: The specified module could not be found.",
        { ocrDevice: "cpu" },
      );

      expect(message).toContain("네이티브 DLL");
      expect(message).toContain("Microsoft Visual C++");
      expect(message).toContain("libpaddle.pyd");
    });

    it("classifies PyTorch Windows DLL loader failures for VC++ auto-repair", () => {
      expect(
        isPaddleNativeDllLoadFailureText(
          "ImportError: DLL load failed while importing _C: The specified procedure could not be found.",
        ),
      ).toBe(true);
      expect(
        isPaddleNativeDllLoadFailureText(
          'OSError: [WinError 126] Error loading "C:\\ocr\\torch\\lib\\fbgemm.dll" or one of its dependencies.',
        ),
      ).toBe(true);
      expect(
        isPaddleNativeDllLoadFailureText(
          'OSError: [WinError 126] Error loading "C:\\plugins\\unrelated.dll".',
        ),
      ).toBe(false);
      expect(
        isPaddleNativeDllLoadFailureText(
          "ModuleNotFoundError: No module named 'torch'",
        ),
      ).toBe(false);
    });

    it("gives backend-specific VC++ guidance for PyTorch OCR DLL failures", () => {
      const failure =
        'OSError: [WinError 126] Error loading "C:\\ocr\\torch\\lib\\c10.dll" or one of its dependencies.';
      const cudaMessage = buildPaddleOcrImportFailureMessage(failure, {
        ocrDevice: "gpu",
        ocrGpuBackend: "cuda",
        ocrEngine: "transformers",
      });
      const rocmMessage = buildPaddleOcrImportFailureMessage(failure, {
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
        ocrEngine: "transformers",
      });

      expect(cudaMessage).toContain("PyTorch CUDA DLL");
      expect(cudaMessage).toContain("Microsoft Visual C++");
      expect(cudaMessage).toContain("c10.dll");
      expect(rocmMessage).toContain("ROCm PyTorch DLL");
      expect(rocmMessage).toContain("Microsoft Visual C++");
      expect(rocmMessage).toContain("c10.dll");
    });

    it("ignores legacy ROCm Paddle OCR package overrides for the Transformers backend", () => {
      const previousPackage =
        process.env.MANGA_TRANSLATOR_OCR_ROCM_PADDLE_PACKAGE;
      const previousIndex =
        process.env.MANGA_TRANSLATOR_OCR_ROCM_PADDLE_INDEX_URL;
      try {
        process.env.MANGA_TRANSLATOR_OCR_ROCM_PADDLE_PACKAGE =
          "paddlepaddle-rocm==3.0.0";
        process.env.MANGA_TRANSLATOR_OCR_ROCM_PADDLE_INDEX_URL =
          "https://example.invalid/rocm/";
        const batches = resolveOcrPipInstallBatches({
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm",
        });

        expect(batches.flat().join(" ")).not.toContain("paddlepaddle-rocm");
        expect(batches.flat().join(" ")).not.toContain("example.invalid");
        expect(batches[3]).toEqual(
          expect.arrayContaining([
            expect.stringContaining("torch-2.9.1%2Brocm7.2.1"),
          ]),
        );
        expect(batches[4]).toContain("paddleocr==3.7.0");
      } finally {
        restoreEnv("MANGA_TRANSLATOR_OCR_ROCM_PADDLE_PACKAGE", previousPackage);
        restoreEnv("MANGA_TRANSLATOR_OCR_ROCM_PADDLE_INDEX_URL", previousIndex);
      }
    });

    it("can skip only the AMD ROCm meta package through an emergency env override", () => {
      const previousSkip =
        process.env.MANGA_TRANSLATOR_OCR_ROCM_SKIP_META_PACKAGE;
      try {
        process.env.MANGA_TRANSLATOR_OCR_ROCM_SKIP_META_PACKAGE = "1";
        const batches = resolveOcrPipInstallBatches({
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
        });
        const flat = batches.flat().join(" ");

        expect(flat).toContain("rocm_sdk_core-7.2.1");
        expect(flat).toContain("rocm_sdk_devel-7.2.1");
        expect(flat).toContain("rocm_sdk_libraries_custom-7.2.1");
        expect(flat).not.toContain("rocm-7.2.1.tar.gz");
        expect(flat).toContain("torch-2.9.1%2Brocm7.2.1");
        expect(flat).toContain("paddleocr==3.7.0");
        expect(flat).toContain("transformers==5.13.1");
      } finally {
        restoreEnv("MANGA_TRANSLATOR_OCR_ROCM_SKIP_META_PACKAGE", previousSkip);
      }
    });

    it("keeps PaddleOCR install batches independent from the selected Gemma model", () => {
      const gemma31B = resolveOcrPipInstallBatches({
        ocrDevice: "gpu",
        ocrGpuCudaTag: "cu129",
        modelRepo: DEFAULT_31B_REPO,
        modelFile: DEFAULT_31B_FILE,
      });
      const gemma26B = resolveOcrPipInstallBatches({
        ocrDevice: "gpu",
        ocrGpuCudaTag: "cu129",
        modelRepo: DEFAULT_26B_REPO,
        modelFile: DEFAULT_26B_FILE,
      });

      expect(gemma26B).toEqual(gemma31B);
    });

    it("always installs Windows PaddleOCR-VL safetensors in a separate no-deps batch", () => {
      const previousGeneric = process.env.MANGA_TRANSLATOR_OCR_PIP_PACKAGES;
      const previousGpu = process.env.MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES;
      try {
        delete process.env.MANGA_TRANSLATOR_OCR_PIP_PACKAGES;
        process.env.MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES =
          "paddleocr[doc-parser]==3.7.0 https://xly-devops.cdn.bcebos.com/safetensors-nightly/safetensors-0.6.2.dev0-cp38-abi3-win_amd64.whl";

        const batches = resolveOcrPipInstallBatches({
          ocrDevice: "gpu",
          ocrGpuCudaTag: "cu129",
        });

        if (process.platform === "win32") {
          expect(batches).toEqual([
            ["paddleocr[doc-parser]==3.7.0"],
            [
              "--no-deps",
              "--force-reinstall",
              "https://xly-devops.cdn.bcebos.com/safetensors-nightly/safetensors-0.6.2.dev0-cp38-abi3-win_amd64.whl",
            ],
          ]);
        } else {
          expect(batches[0]).toContain("paddleocr[doc-parser]==3.7.0");
        }
      } finally {
        restoreEnv("MANGA_TRANSLATOR_OCR_PIP_PACKAGES", previousGeneric);
        restoreEnv("MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES", previousGpu);
      }
    });

    it("keeps the legacy CUDA package override out of Transformers OCR", () => {
      const previousGeneric = process.env.MANGA_TRANSLATOR_OCR_PIP_PACKAGES;
      const previousGpu = process.env.MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES;
      const previousTransformers =
        process.env.MANGA_TRANSLATOR_OCR_CUDA_TRANSFORMERS_PIP_PACKAGES;
      try {
        delete process.env.MANGA_TRANSLATOR_OCR_PIP_PACKAGES;
        delete process.env.MANGA_TRANSLATOR_OCR_CUDA_TRANSFORMERS_PIP_PACKAGES;
        process.env.MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES =
          "legacy-paddle-package==1.2.3";

        const legacyBatches = resolveOcrPipInstallBatches({
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
          ocrGpuCudaTag: "cu126",
        });
        const transformersBatches = resolveOcrPipInstallBatches({
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
          ocrGpuCudaTag: "cu126",
          ocrEngine: "transformers",
        });

        expect(legacyBatches.flat()).toContain("legacy-paddle-package==1.2.3");
        expect(transformersBatches.flat()).not.toContain(
          "legacy-paddle-package==1.2.3",
        );
        expect(transformersBatches[1]).toContain("torch==2.9.1");
        expect(transformersBatches[2]).toContain("transformers==5.13.1");
      } finally {
        restoreEnv("MANGA_TRANSLATOR_OCR_PIP_PACKAGES", previousGeneric);
        restoreEnv("MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES", previousGpu);
        restoreEnv(
          "MANGA_TRANSLATOR_OCR_CUDA_TRANSFORMERS_PIP_PACKAGES",
          previousTransformers,
        );
      }
    });

    it("uses the dedicated CUDA Transformers package override", () => {
      const previousGeneric = process.env.MANGA_TRANSLATOR_OCR_PIP_PACKAGES;
      const previous =
        process.env.MANGA_TRANSLATOR_OCR_CUDA_TRANSFORMERS_PIP_PACKAGES;
      try {
        delete process.env.MANGA_TRANSLATOR_OCR_PIP_PACKAGES;
        process.env.MANGA_TRANSLATOR_OCR_CUDA_TRANSFORMERS_PIP_PACKAGES =
          "custom-torch-stack==9.9 custom-transformers-stack==9.9";

        expect(
          resolveOcrPipInstallBatches({
            ocrDevice: "gpu",
            ocrGpuBackend: "cuda",
            ocrEngine: "transformers",
          }),
        ).toEqual([
          ["custom-torch-stack==9.9", "custom-transformers-stack==9.9"],
        ]);
      } finally {
        restoreEnv("MANGA_TRANSLATOR_OCR_PIP_PACKAGES", previousGeneric);
        restoreEnv(
          "MANGA_TRANSLATOR_OCR_CUDA_TRANSFORMERS_PIP_PACKAGES",
          previous,
        );
      }
    });

    it("keeps RTX 50 Paddle OCR verification lightweight and gives cu129 more startup time", () => {
      const previous = process.env.MANGA_TRANSLATOR_OCR_IMPORT_TIMEOUT_MS;
      delete process.env.MANGA_TRANSLATOR_OCR_IMPORT_TIMEOUT_MS;
      try {
        const script = buildPaddleOcrImportCheckScript({
          ocrDevice: "gpu",
          ocrGpuCudaTag: "cu129",
        });
        expect(script).toContain("importlib.util.find_spec");
        expect(script).toContain("import paddle");
        expect(script).toContain(
          "from paddleocr import PaddleOCRVL, PaddleOCR",
        );
        expect(script).not.toContain("import paddle, paddlex, paddleocr");
        expect(script).not.toContain("torch.version");
        expect(script).toContain("paddle.set_device");
        expect(
          resolvePaddleOcrImportCheckTimeoutMs({
            ocrDevice: "gpu",
            ocrGpuCudaTag: "cu129",
          }),
        ).toBeGreaterThanOrEqual(300000);
        expect(
          resolvePaddleOcrImportCheckTimeoutMs({
            ocrDevice: "gpu",
            ocrGpuCudaTag: "cu126",
          }),
        ).toBeGreaterThanOrEqual(180000);
        expect(
          resolvePaddleOcrImportCheckTimeoutMs({ ocrDevice: "cpu" }),
        ).toBeGreaterThanOrEqual(120000);
      } finally {
        restoreEnv("MANGA_TRANSLATOR_OCR_IMPORT_TIMEOUT_MS", previous);
      }
    });
  },
);
