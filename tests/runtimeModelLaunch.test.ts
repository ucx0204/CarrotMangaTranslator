import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  BEELLAMA_LLAMA_RUNTIME_CUDA13,
  DEFAULT_26B_FILE,
  DEFAULT_26B_REPO,
  DEFAULT_31B_FILE,
  DEFAULT_31B_REPO,
  DEFAULT_MMPROJ_FILE,
  DEFAULT_MMPROJ_REPO,
  LLAMA_RUNTIME_FILES,
  MAINLINE_LLAMA_RUNTIME_CUDA13,
  buildLlamaServerEnv,
  buildOcrBboxBatchCommand,
  buildOcrBboxCommand,
  buildOcrRuntimeEnv,
  buildPaddleOcrImportCheckScript,
  buildPaddleOcrImportFailureMessage,
  collectOcrBboxHints,
  collectRequiredPaddleOcrModelDownloads,
  createTempDir,
  parseOcrBatchProgressLine,
  parsePaddleModelFetchProgress,
  parsePipRawProgress,
  requestTranslation,
  resolveBundledServerPath,
  resolveFfmpegPath,
  resolveLlamaCppCacheDir,
  resolveOcrBboxTimeoutMs,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrInstallBatchProgressRanges,
  resolveOcrPipInstallBatches,
  resolveOcrRuntimeVariant,
  resolvePaddleOcrImportCheckTimeoutMs,
  restoreEnv,
  runtimeDefaults,
  shouldExtractLlamaRuntimeFile,
  withOcrBatchPipelineStubs,
  bundledServerCandidates,
} from "./helpers/runtimeModelContracts";

describe("runtime model support helpers", () => {
  it("keeps CJS runtime model defaults aligned with shared model presets", () => {
    expect(runtimeDefaults.DEFAULT_MODEL_HF).toBe(DEFAULT_31B_REPO);
    expect(runtimeDefaults.DEFAULT_HF_FILE).toBe(DEFAULT_31B_FILE);
    expect(runtimeDefaults.DEFAULT_MMPROJ_HF).toBe(DEFAULT_MMPROJ_REPO);
    expect(runtimeDefaults.DEFAULT_MMPROJ_FILE).toBe(DEFAULT_MMPROJ_FILE);
  });

  it("resolves the preferred bundled beellama llama-server when present", () => {
    const toolsDir = createTempDir("llama-tools-");
    const runtimeDir = join(toolsDir, "beellama-v0.2.0-cuda12.4");
    mkdirSync(runtimeDir, { recursive: true });
    const serverPath = join(runtimeDir, "llama-server.exe");
    writeFileSync(serverPath, "");
    writeFileSync(join(runtimeDir, "ggml-cuda.dll"), "");

    expect(resolveBundledServerPath(toolsDir)).toBe(serverPath);
    expect(bundledServerCandidates(toolsDir)).toContain(serverPath);
  });

  it("resolves another bundled llama-server when the preferred runtime is absent", () => {
    const toolsDir = createTempDir("llama-tools-");
    const runtimeDir = join(toolsDir, "llama-b9547-cuda12.4");
    mkdirSync(runtimeDir, { recursive: true });
    const serverPath = join(runtimeDir, "llama-server.exe");
    writeFileSync(serverPath, "");
    writeFileSync(join(runtimeDir, "ggml-cuda.dll"), "");

    expect(resolveBundledServerPath(toolsDir)).toBe(serverPath);
  });

  it("discovers a one-level bundled llama-server directory unknown to the fixed runtime list", () => {
    const toolsDir = createTempDir("llama-tools-");
    const runtimeDir = join(toolsDir, "custom-llama-runtime");
    mkdirSync(runtimeDir, { recursive: true });
    const serverPath = join(runtimeDir, "llama-server.exe");
    writeFileSync(serverPath, "");
    writeFileSync(join(runtimeDir, "ggml-cuda-cu12.dll"), "");

    expect(resolveBundledServerPath(toolsDir)).toBe(serverPath);
  });

  it("parses pip raw progress without inventing elapsed-time progress", () => {
    expect(parsePipRawProgress("Progress 32768 of 1048576")).toEqual({
      current: 32768,
      total: 1048576,
    });
    expect(parsePipRawProgress("Collecting paddleocr")).toBeNull();
  });

  it("parses OCR batch progress JSON lines", () => {
    expect(
      parseOcrBatchProgressLine(
        '{"index":2,"total":65,"output":"page.json","count":14}',
      ),
    ).toEqual({
      phase: "done",
      index: 2,
      total: 65,
      count: 14,
    });
    expect(
      parseOcrBatchProgressLine(
        '{"phase":"start","index":3,"total":65,"output":"page.json","count":0}',
      ),
    ).toEqual({
      phase: "start",
      index: 3,
      total: 65,
      count: 0,
    });
    expect(parseOcrBatchProgressLine('{"items":[],"count":65}')).toBeNull();
    expect(parseOcrBatchProgressLine("[paddleocr] warmup")).toBeNull();
  });

  it("parses Paddle model fetch progress lines", () => {
    expect(
      parsePaddleModelFetchProgress(
        "Fetching 19 files: 11%|█ | 2/19 [00:00<00:07, 2.14it/s]",
      ),
    ).toEqual({
      totalFiles: 19,
      currentFiles: 2,
      percent: 11,
    });
    expect(
      parsePaddleModelFetchProgress(
        "Creating model: ('PaddleOCR-VL-1.6-0.9B', None, None)",
      ),
    ).toBeNull();
  });

  it("allows slow first-run Paddle model downloads before timing out OCR bbox analysis", () => {
    const previous = process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS;
    delete process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS;
    try {
      expect(resolveOcrBboxTimeoutMs(1)).toBeGreaterThanOrEqual(60 * 60 * 1000);
      expect(resolveOcrBboxTimeoutMs(20)).toBeGreaterThanOrEqual(
        60 * 60 * 1000,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS;
      } else {
        process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS = previous;
      }
    }
  });

  it("prepares Paddle OCR model downloads in the PaddleX official cache", () => {
    const runtimeDir = createTempDir("ocr-runtime-");
    const tasks = collectRequiredPaddleOcrModelDownloads({}, { runtimeDir });

    expect(tasks).toHaveLength(34);
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: "PaddlePaddle/PP-DocLayoutV3",
          file: "inference.pdiparams",
          destination: join(
            runtimeDir,
            "paddlex-cache",
            "official_models",
            "PP-DocLayoutV3",
            "inference.pdiparams",
          ),
        }),
        expect.objectContaining({
          repo: "PaddlePaddle/PaddleOCR-VL-1.6",
          file: "model.safetensors",
          destination: join(
            runtimeDir,
            "paddlex-cache",
            "official_models",
            "PaddleOCR-VL-1.6",
            "model.safetensors",
          ),
        }),
        expect.objectContaining({
          repo: "PaddlePaddle/PP-OCRv6_medium_det",
          file: "inference.pdiparams",
          destination: join(
            runtimeDir,
            "paddlex-cache",
            "official_models",
            "PP-OCRv6_medium_det",
            "inference.pdiparams",
          ),
        }),
        expect.objectContaining({
          repo: "PaddlePaddle/PP-OCRv6_medium_rec",
          file: "inference.pdiparams",
          destination: join(
            runtimeDir,
            "paddlex-cache",
            "official_models",
            "PP-OCRv6_medium_rec",
            "inference.pdiparams",
          ),
        }),
      ]),
    );
  });

  it("does not predownload PaddleOCRVL model assets for AMD ROCm Transformers OCR", () => {
    const runtimeDir = createTempDir("ocr-runtime-");
    const tasks = collectRequiredPaddleOcrModelDownloads(
      { ocrDevice: "gpu", ocrGpuBackend: "rocm-transformers" },
      { runtimeDir },
    );

    expect(tasks).toEqual([]);
  });

  it("disables hf-xet for Paddle OCR Python downloads by default", () => {
    const runtimeDir = createTempDir("ocr-runtime-");
    const previousDisableXet = process.env.HF_HUB_DISABLE_XET;
    const previousDownloadTimeout = process.env.HF_HUB_DOWNLOAD_TIMEOUT;
    const previousSecret = process.env.MGT_UNRELATED_SECRET;
    delete process.env.HF_HUB_DISABLE_XET;
    delete process.env.HF_HUB_DOWNLOAD_TIMEOUT;
    process.env.MGT_UNRELATED_SECRET = "secret";
    try {
      const env = buildOcrRuntimeEnv(
        {},
        { runtimeDir, includePackageDir: false },
      );
      expect(env.HF_HUB_DISABLE_XET).toBe("1");
      expect(env.HF_HUB_DOWNLOAD_TIMEOUT).toBe("300");
      expect(env.MGT_UNRELATED_SECRET).toBeUndefined();
      expect(env.PYTHONHOME).toBeUndefined();
    } finally {
      if (previousDisableXet === undefined) {
        delete process.env.HF_HUB_DISABLE_XET;
      } else {
        process.env.HF_HUB_DISABLE_XET = previousDisableXet;
      }
      if (previousDownloadTimeout === undefined) {
        delete process.env.HF_HUB_DOWNLOAD_TIMEOUT;
      } else {
        process.env.HF_HUB_DOWNLOAD_TIMEOUT = previousDownloadTimeout;
      }
      restoreEnv("MGT_UNRELATED_SECRET", previousSecret);
    }
  });

  it("namespaces the default llama.cpp cache under app data", () => {
    const previousLlamaCache = process.env.MANGA_TRANSLATOR_LLAMA_CACHE_DIR;
    const previousLocalAppData = process.env.LOCALAPPDATA;
    const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
    const previousHome = process.env.HOME;
    delete process.env.MANGA_TRANSLATOR_LLAMA_CACHE_DIR;
    try {
      if (process.platform === "win32") {
        const localAppData = createTempDir("local-app-data-");
        process.env.LOCALAPPDATA = localAppData;
        expect(resolveLlamaCppCacheDir()).toBe(
          join(localAppData, "manga-gemma-translator", "llama.cpp"),
        );
      } else {
        const xdgCacheHome = createTempDir("xdg-cache-");
        process.env.XDG_CACHE_HOME = xdgCacheHome;
        expect(resolveLlamaCppCacheDir()).toBe(
          join(xdgCacheHome, "manga-gemma-translator", "llama.cpp"),
        );
      }
    } finally {
      restoreEnv("MANGA_TRANSLATOR_LLAMA_CACHE_DIR", previousLlamaCache);
      restoreEnv("LOCALAPPDATA", previousLocalAppData);
      restoreEnv("XDG_CACHE_HOME", previousXdgCacheHome);
      restoreEnv("HOME", previousHome);
    }
  });

  it("builds a minimal llama-server environment with app-scoped caches", () => {
    const toolsDir = createTempDir("llama-tools-");
    const runtimeDir = join(toolsDir, "beellama-v0.2.0-cuda12.4");
    const serverPath = join(
      runtimeDir,
      process.platform === "win32" ? "llama-server.exe" : "llama-server",
    );
    const llamaCacheDir = join(toolsDir, "llama-cache");
    const previousSecret = process.env.MGT_UNRELATED_SECRET;
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(serverPath, "server");
    process.env.MGT_UNRELATED_SECRET = "secret";
    try {
      const env = buildLlamaServerEnv(serverPath, {
        port: 18180,
        toolsDir,
        hfHomeDir: join(toolsDir, "hf-cache"),
        hfHubCacheDir: join(toolsDir, "hf-cache", "hub"),
        llamaCacheDir,
      });
      const pathParts = String(env.PATH ?? "").split(delimiter);

      expect(env.MGT_UNRELATED_SECRET).toBeUndefined();
      expect(env.MANGA_TRANSLATOR_LLAMA_PORT).toBe("18180");
      expect(env.HF_HOME).toBe(join(toolsDir, "hf-cache"));
      expect(env.HF_HUB_CACHE).toBe(join(toolsDir, "hf-cache", "hub"));
      expect(env.LLAMA_CACHE).toBe(llamaCacheDir);
      expect(env.LLAMA_CACHE_DIR).toBe(llamaCacheDir);
      expect(pathParts).toContain(runtimeDir);
    } finally {
      restoreEnv("MGT_UNRELATED_SECRET", previousSecret);
    }
  });

  it("uses the configured CUDA tag for isolated Paddle OCR GPU runtimes", () => {
    const runtimeDir = createTempDir("ocr-runtime-");
    const previousCudaTag = process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG;
    const previousPaddleCudaTag =
      process.env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG;
    const previousOcrGpuCuda = process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA;
    const previousIndexUrl =
      process.env.MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL;
    const previousPaddleIndexUrl =
      process.env.MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL;
    delete process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG;
    delete process.env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG;
    delete process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA;
    delete process.env.MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL;
    delete process.env.MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL;
    try {
      expect(resolveOcrGpuCudaTag({ ocrGpuCudaTag: "cu129" })).toBe("cu129");
      expect(resolveOcrGpuPackageIndexUrl({ ocrGpuCudaTag: "cu129" })).toBe(
        "https://www.paddlepaddle.org.cn/packages/stable/cu129/",
      );
      const env = buildOcrRuntimeEnv(
        { ocrDevice: "gpu", ocrGpuCudaTag: "cu129" },
        { runtimeDir, includePackageDir: false },
      );
      expect(env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG).toBe("cu129");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE).toBe("gpu:0");
    } finally {
      restoreEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG", previousCudaTag);
      restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG", previousPaddleCudaTag);
      restoreEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA", previousOcrGpuCuda);
      restoreEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL", previousIndexUrl);
      restoreEnv(
        "MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL",
        previousPaddleIndexUrl,
      );
    }
  });

  it("uses official cu129 Paddle OCR packages and Windows safetensors for RTX 50 GPU OCR runtimes", () => {
    const cu129Batches = resolveOcrPipInstallBatches({
      ocrDevice: "gpu",
      ocrGpuCudaTag: "cu129",
    });
    const cu126Batches = resolveOcrPipInstallBatches({
      ocrDevice: "gpu",
      ocrGpuCudaTag: "cu126",
    });
    const cpuBatches = resolveOcrPipInstallBatches({ ocrDevice: "cpu" });

    expect(cu129Batches[0]).toEqual([
      "paddlepaddle-gpu==3.3.1",
      "--index-url",
      "https://www.paddlepaddle.org.cn/packages/stable/cu129/",
    ]);
    expect(cu129Batches[1]).toEqual(["paddleocr[doc-parser]==3.7.0"]);
    if (process.platform === "win32") {
      expect(cu129Batches[2][0]).toBe("--no-deps");
      expect(cu129Batches[2][1]).toBe("--force-reinstall");
      expect(cu129Batches[2][2]).toContain("safetensors-0.6.2.dev0");
    }
    expect(cu126Batches[0]).toEqual([
      "paddlepaddle-gpu==3.3.1",
      "--index-url",
      "https://www.paddlepaddle.org.cn/packages/stable/cu126/",
    ]);
    expect(cu126Batches[1]).toEqual(["paddleocr[doc-parser]==3.7.0"]);
    expect(cpuBatches[0][0]).toBe("paddlepaddle==3.3.1");
    expect(cpuBatches[0][1]).toBe("paddleocr[doc-parser]==3.7.0");
    if (process.platform === "win32") {
      expect(cu126Batches[2][0]).toBe("--no-deps");
      expect(cu126Batches[2][1]).toBe("--force-reinstall");
      expect(cu126Batches[2][2]).toContain("safetensors-0.6.2.dev0");
      expect(cpuBatches[1][0]).toBe("--no-deps");
      expect(cpuBatches[1][1]).toBe("--force-reinstall");
      expect(cpuBatches[1][2]).toContain("safetensors-0.6.2.dev0");
    }
  });

  it("uses native Windows ROCm PyTorch packages for AMD Transformers OCR runtimes", () => {
    const rocmBatches = resolveOcrPipInstallBatches({
      ocrDevice: "gpu",
      ocrGpuBackend: "rocm",
    });
    const env = buildOcrRuntimeEnv(
      { ocrDevice: "gpu", ocrGpuBackend: "rocm" },
      { runtimeDir: "C:/ocr-runtime", includePackageDir: false },
    );
    const script = buildPaddleOcrImportCheckScript({
      ocrDevice: "gpu",
      ocrGpuBackend: "rocm",
    });

    expect(resolveOcrGpuBackend({ ocrGpuBackend: "amd" })).toBe(
      "rocm-transformers",
    );
    expect(rocmBatches[0]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("rocm_sdk_core-7.2.1"),
        expect.stringContaining("rocm_sdk_devel-7.2.1"),
        expect.stringContaining("rocm_sdk_libraries_custom-7.2.1"),
        expect.stringContaining("rocm-7.2.1.tar.gz"),
      ]),
    );
    expect(rocmBatches[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("torch-2.9.1%2Brocm7.2.1"),
        expect.stringContaining("torchaudio-2.9.1%2Brocm7.2.1"),
        expect.stringContaining("torchvision-0.24.1%2Brocm7.2.1"),
      ]),
    );
    expect(rocmBatches[2]).toEqual([
      "paddleocr==3.7.0",
      "transformers>=5.10.0",
      "safetensors>=0.6.2",
    ]);
    expect(rocmBatches.flat().join(" ")).not.toContain("paddlepaddle-gpu");
    expect(rocmBatches.flat().join(" ")).not.toContain("/cu126/");
    expect(env.MANGA_TRANSLATOR_OCR_GPU_BACKEND).toBe("rocm-transformers");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE).toBe("gpu:0");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBe("transformers");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE).toBe("float16");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE).toBe("ocr");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_VERSION).toBe("PP-OCRv6");
    expect(script).toContain("import torch");
    expect(script).toContain("torch.cuda.is_available()");
    expect(script).toContain("torch.version");
    expect(script).toContain("from paddleocr import PaddleOCR");
    expect(script).not.toContain("import paddle");
    expect(script).not.toContain("PaddleOCRVL");
    expect(resolveOcrRuntimeVariant({ ocrDevice: "cpu" })).toBe("cpu");
    expect(
      resolveOcrRuntimeVariant({ ocrDevice: "gpu", ocrGpuCudaTag: "cu126" }),
    ).toBe("gpu-cu126");
    expect(
      resolveOcrRuntimeVariant({ ocrDevice: "gpu", ocrGpuCudaTag: "cu129" }),
    ).toBe("gpu-cu129");
    expect(
      resolveOcrRuntimeVariant({
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
      }),
    ).toBe("gpu-rocm-transformers");
  });

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

    expect(cpuCommand).not.toContain("--engine");
    expect(cpuCommand).not.toContain("--bbox-mode");
    expect(cudaCommand).not.toContain("--engine");
    expect(cudaCommand).not.toContain("--bbox-mode");
    expect(amdCommand).toContain("--bbox-mode");
    expect(amdCommand).toContain("ocr");
    expect(amdCommand).toContain("--engine");
    expect(amdCommand).toContain("transformers");
    expect(amdCommand).toContain("--dtype");
    expect(amdCommand).toContain("float16");
    expect(amdCommand).toContain("--ocr-version");
    expect(amdCommand).toContain("PP-OCRv6");
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
      expect(batches[1]).toEqual(
        expect.arrayContaining([
          expect.stringContaining("torch-2.9.1%2Brocm7.2.1"),
        ]),
      );
      expect(batches[2]).toContain("paddleocr==3.7.0");
    } finally {
      restoreEnv("MANGA_TRANSLATOR_OCR_ROCM_PADDLE_PACKAGE", previousPackage);
      restoreEnv("MANGA_TRANSLATOR_OCR_ROCM_PADDLE_INDEX_URL", previousIndex);
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
      expect(script).toContain("from paddleocr import PaddleOCRVL, PaddleOCR");
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

  it("prefers the bundled ffmpeg from the tools directory", () => {
    const toolsDir = createTempDir("tools-");
    const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const ffmpegPath = join(toolsDir, "ffmpeg", binaryName);
    mkdirSync(join(toolsDir, "ffmpeg"), { recursive: true });
    writeFileSync(ffmpegPath, "binary");

    expect(resolveFfmpegPath({ toolsDir })).toBe(ffmpegPath);
  });

  it("does not fall back to system ffmpeg from a packaged tools directory", () => {
    const packagedRoot = createTempDir("packaged-");
    const toolsDir = join(packagedRoot, "resources", "tools");
    mkdirSync(toolsDir, { recursive: true });

    expect(() => resolveFfmpegPath({ toolsDir })).toThrow(
      "Bundled ffmpeg is missing",
    );
  });

  it("streams OCR batch progress without inheriting the first page index during runtime setup", async () => {
    const outputDir = createTempDir("ocr-batch-progress-");
    const progressEvents: Array<Record<string, unknown>> = [];
    const runtimeSetupOptions: Array<Record<string, unknown>> = [];
    let observedBatchPath = "";

    await withOcrBatchPipelineStubs(
      {
        ensurePaddleOcrRuntime(options) {
          runtimeSetupOptions.push({ ...options });
          return {
            pythonPath: "python",
            runtimeDir: join(outputDir, "runtime"),
            prepared: true,
            diagnostics: [],
          };
        },
        buildOcrBboxBatchCommand(_options, batchPath) {
          observedBatchPath = batchPath;
          return "ocr-batch-command";
        },
        async runShellCommand(_command, options) {
          options.onOutput?.(
            JSON.stringify({ phase: "start", index: 1, total: 2, count: 0 }),
          );
          const batch = JSON.parse(readFileSync(observedBatchPath, "utf8")) as {
            items: Array<{ output: string }>;
          };
          for (const [index, item] of batch.items.entries()) {
            writeFileSync(
              item.output,
              JSON.stringify([
                {
                  label: "text",
                  bbox: [10 + index, 20, 40 + index, 60],
                  text: "日本語",
                },
              ]),
              "utf8",
            );
          }
          options.onOutput?.(
            JSON.stringify({ phase: "done", index: 1, total: 2, count: 1 }),
          );
          return { stdout: "", stderr: "" };
        },
      },
      async ({ collectOcrBboxHintsBatch }) => {
        const results = await collectOcrBboxHintsBatch([
          {
            imagePath: join(outputDir, "page-1.png"),
            outputDir,
            imageWidth: 100,
            imageHeight: 100,
            ocrBboxProvider: "paddleocr-vl",
            ocrPageIndex: 7,
            ocrPageTotal: 9,
            ocrBatchCompletedBefore: 6,
            ocrBatchTotal: 9,
            onProgress: (event: Record<string, unknown>) => {
              progressEvents.push(event);
            },
          },
          {
            imagePath: join(outputDir, "page-2.png"),
            outputDir,
            imageWidth: 100,
            imageHeight: 100,
            ocrBboxProvider: "paddleocr-vl",
            ocrPageIndex: 8,
            ocrPageTotal: 9,
            onProgress: (event: Record<string, unknown>) => {
              progressEvents.push(event);
            },
          },
        ]);

        expect(results).toHaveLength(2);
        expect(results[0]?.hints).toHaveLength(1);
      },
    );

    expect(runtimeSetupOptions).toHaveLength(1);
    expect(runtimeSetupOptions[0]).not.toHaveProperty("ocrPageIndex");
    expect(runtimeSetupOptions[0]).not.toHaveProperty("ocrPageTotal");
    expect(runtimeSetupOptions[0]).not.toHaveProperty("pageIndex");
    expect(runtimeSetupOptions[0]).not.toHaveProperty("pageTotal");
    expect(progressEvents[0]).toMatchObject({
      phase: "ocr_running",
      progressText: "Paddle OCR 배치 위치 분석 중",
      pageIndex: null,
      pageTotal: null,
      progressCurrent: 6,
      progressTotal: 9,
    });
    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        phase: "ocr_running",
        progressText: "7 / 9 페이지 Paddle OCR 분석 중",
        pageIndex: 7,
        pageTotal: 9,
        progressCurrent: 6,
        progressTotal: 9,
      }),
    );
    expect(progressEvents).toContainEqual(
      expect.objectContaining({
        progressText: "7 / 9 페이지 Paddle OCR 분석 중",
        detail: "1개 후보",
        progressCurrent: 7,
      }),
    );
  });

  it("keeps the CUDA 13 llama-server implementation DLL in the managed runtime", () => {
    const flattenRequiredFiles = (files: Array<string | string[]>): string[] =>
      files.flatMap((file) => (Array.isArray(file) ? file : file));

    expect(MAINLINE_LLAMA_RUNTIME_CUDA13.id).toBe("llama-b9547-cuda13.3");
    expect(
      flattenRequiredFiles(MAINLINE_LLAMA_RUNTIME_CUDA13.requiredFiles),
    ).toContain("llama-server-impl.dll");
    expect(
      flattenRequiredFiles(BEELLAMA_LLAMA_RUNTIME_CUDA13.requiredFiles),
    ).not.toContain("llama-server-impl.dll");
    expect(LLAMA_RUNTIME_FILES.has("llama-server-impl.dll")).toBe(true);
    expect(shouldExtractLlamaRuntimeFile("llama-server-impl.dll")).toBe(true);
    expect(shouldExtractLlamaRuntimeFile("vendor-only.dll")).toBe(true);
    expect(
      shouldExtractLlamaRuntimeFile(
        "TensileLibrary.dat",
        "rocblas/library/TensileLibrary.dat",
      ),
    ).toBe(true);
    expect(
      shouldExtractLlamaRuntimeFile(
        "hipblaslt.dat",
        "hipblaslt/library/hipblaslt.dat",
      ),
    ).toBe(true);
    expect(shouldExtractLlamaRuntimeFile("readme.txt")).toBe(false);
  });

  it("treats an explicitly empty OCR hint array as a completed OCR pass", async () => {
    const result = await collectOcrBboxHints({
      ocrBboxHints: [],
      ocrBboxProvider: "none",
    });

    expect(result).toMatchObject({
      hints: [],
      diagnostics: [{ provider: "inline", hintCount: 0 }],
      noTextDetected: true,
      textEvidenceCount: 0,
    });
  });

  it("preserves OCR prepass no-text state when the full result is provided", async () => {
    const result = await collectOcrBboxHints({
      ocrBboxResult: {
        hints: [],
        diagnostics: [
          { provider: "paddleocr-vl", reason: "uncertain-empty-result" },
        ],
        noTextDetected: false,
        textEvidenceCount: 0,
      },
      ocrBboxProvider: "none",
    });

    expect(result).toMatchObject({
      hints: [],
      diagnostics: [
        { provider: "paddleocr-vl", reason: "uncertain-empty-result" },
      ],
      noTextDetected: false,
      textEvidenceCount: 0,
    });
  });

  it("does not skip model analysis when OCR found geometry without readable Japanese transcript", async () => {
    const noEvidence = await collectOcrBboxHints({
      ocrBboxHints: [{ id: 1, label: "text", x1: 10, y1: 20, x2: 80, y2: 90 }],
    });
    const hasEvidence = await collectOcrBboxHints({
      ocrBboxHints: [
        {
          id: 1,
          label: "text",
          x1: 10,
          y1: 20,
          x2: 80,
          y2: 90,
          ocrText: "1998年1月",
        },
      ],
    });

    expect(noEvidence).toMatchObject({
      noTextDetected: false,
      textEvidenceCount: 0,
    });
    expect(hasEvidence).toMatchObject({
      noTextDetected: false,
      textEvidenceCount: 1,
    });
  });

  it("returns a synthetic empty overlay instead of calling a model for no-text OCR pages", async () => {
    const result = await requestTranslation(
      { baseUrl: "http://127.0.0.1:1" },
      {
        label: "blank-page",
        modelProvider: "gemma",
        imageWidth: 1000,
        imageHeight: 1000,
        ocrBboxHints: [],
      },
    );

    expect(JSON.parse(result.outputText)).toEqual({ items: [] });
    expect(result.rawResponse).toMatchObject({
      skipped: true,
      reason: "ocr-no-text",
    });
    expect(result.requestBody).toMatchObject({
      noTextDetected: true,
      ocrTextEvidenceCount: 0,
    });
  });

  it("weights OCR GPU install batches so one completed download does not imply half the install is done", () => {
    const ranges = resolveOcrInstallBatchProgressRanges(
      [
        [
          "paddlepaddle-gpu==3.3.1",
          "--extra-index-url",
          "https://www.paddlepaddle.org.cn/packages/stable/cu126/",
        ],
        ["paddleocr[doc-parser]==3.7.0"],
      ],
      0.1,
      0.86,
    );

    expect(ranges).toHaveLength(2);
    expect(ranges[0].start).toBeCloseTo(0.1);
    expect(ranges[0].end).toBeGreaterThan(0.36);
    expect(ranges[0].end).toBeLessThan(0.39);
    expect(ranges[1].start).toBeCloseTo(ranges[0].end);
    expect(ranges[1].end).toBeCloseTo(0.86);
  });
});
