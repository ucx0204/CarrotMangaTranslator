import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  BEELLAMA_LLAMA_RUNTIME_CUDA13,
  DEFAULT_26B_FILE,
  DEFAULT_26B_MMPROJ_FILE,
  DEFAULT_26B_MMPROJ_REPO,
  DEFAULT_26B_REPO,
  DEFAULT_31B_FILE,
  DEFAULT_31B_REPO,
  DEFAULT_MMPROJ_FILE,
  DEFAULT_MMPROJ_REPO,
  LLAMA_RUNTIME_FILES,
  MAINLINE_LLAMA_RUNTIME_CUDA13,
  buildOcrPipBuildToolUpgradeCommand,
  buildOcrPipInstallCommand,
  buildLlamaServerEnv,
  buildOcrBboxBatchCommand,
  buildOcrBboxCommand,
  buildCpuFallbackOcrOptions,
  buildOcrRuntimeEnv,
  buildPaddleOcrGpuFailureMessage,
  buildPaddleOcrImportCheckScript,
  buildPaddleOcrImportFailureMessage,
  collectOcrBboxHints,
  collectRequiredHfDownloads,
  isGpuDeviceLostOrTdrText,
  isGpuOutOfMemoryText,
  isRocmHipAccessViolationText,
  resolveEffectiveOcrDevice,
  collectRequiredPaddleOcrModelDownloads,
  createTempDir,
  hasOcrCpuWorkerRamHeadroom,
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
  resolveOcrCpuWorkerMinFreeRamRatio,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrInstallBatchLabel,
  resolveOcrInstallBatchProgressRanges,
  isWindowsRocmOcrRuntimePathShortEnough,
  resolveOcrPipInstallBatches,
  resolveOcrPipCacheDir,
  resolveOcrPipInstallExtraArgs,
  resolveOcrPythonPackageDir,
  resolveOcrPythonUserBaseDir,
  resolveOcrRuntimeDir,
  resolveOcrRuntimeVariant,
  resolveOcrTempDir,
  resolveOcrVenvDir,
  resolvePaddleOcrImportCheckTimeoutMs,
  restoreEnv,
  runtimeDefaults,
  shouldExtractLlamaRuntimeFile,
  summarizeOcrInstallBatches,
  withOcrBatchPipelineStubs,
  bundledServerCandidates,
} from "./helpers/runtimeModelContracts";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("runtime model support helpers", () => {
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
    const detectorWeights = tasks.find(
      (task) =>
        task.repo === "PaddlePaddle/PP-OCRv6_medium_det" &&
        task.file === "inference.pdiparams",
    );
    expect(detectorWeights).toMatchObject({
      revision: "8e0f56fb2ef86b461d99cfc7ac5c137738985f61",
      expectedSha256:
        "85218d2e3d98f5a21c58b4220627be923a97aee5db3cc71f39536ab31ac53960",
    });
    expect(detectorWeights?.url).toContain(
      "/resolve/8e0f56fb2ef86b461d99cfc7ac5c137738985f61/",
    );
  });

  it("pins built-in Gemma downloads to immutable revisions and SHA-256", () => {
    const workingDir = createTempDir("gemma-pins-");
    const tasks = collectRequiredHfDownloads({
      workingDir,
      hfHubCacheDir: join(workingDir, "hf-hub"),
      modelProvider: "gemma",
      modelSource: "huggingface",
      modelRepo: DEFAULT_26B_REPO,
      modelFile: DEFAULT_26B_FILE,
      mmprojRepo: DEFAULT_26B_MMPROJ_REPO,
      mmprojFile: DEFAULT_26B_MMPROJ_FILE,
    });

    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repo: DEFAULT_26B_REPO,
          file: DEFAULT_26B_FILE,
          revision: "9cada68ea11a8f361e4b16a7a97e53d99b0918c0",
          expectedSha256:
            "b7c13509c19383cf8fa4c8b1731ff5bd3a6e2f0e0ca5a63958afee1ee64f387d",
        }),
        expect.objectContaining({
          repo: DEFAULT_26B_MMPROJ_REPO,
          file: DEFAULT_26B_MMPROJ_FILE,
          revision: "8842483d589b4add67223d1d8c3fff81a3d5260e",
          expectedSha256:
            "b9dd7e71eb78b44c4c9d3a0aa6173a1e022c2c4f58aa0fd03807be3f8cba4353",
        }),
      ]),
    );
    expect(
      tasks.every((task) => task.url.includes(`/resolve/${task.revision}/`)),
    ).toBe(true);
  });

  it("does not predownload PaddleOCRVL model assets for AMD ROCm Transformers OCR", () => {
    const runtimeDir = createTempDir("ocr-runtime-");
    const tasks = collectRequiredPaddleOcrModelDownloads(
      { ocrDevice: "gpu", ocrGpuBackend: "rocm-transformers" },
      { runtimeDir },
    );

    expect(tasks).toEqual([]);
  });

  it("predownloads selected low-VRAM PaddleOCR textline models only", () => {
    const runtimeDir = createTempDir("ocr-runtime-");
    const economyTasks = collectRequiredPaddleOcrModelDownloads(
      {
        ocrTextDetectionModelName: "PP-OCRv6_small_det",
        ocrTextRecognitionModelName: "PP-OCRv6_small_rec",
      },
      { runtimeDir },
    );
    const minimumTasks = collectRequiredPaddleOcrModelDownloads(
      {
        ocrTextDetectionModelName: "PP-OCRv6_small_det",
        ocrTextRecognitionModelName: "PP-OCRv6_tiny_rec",
      },
      { runtimeDir },
    );

    expect(economyTasks.map((task) => task.repo)).toEqual(
      expect.arrayContaining([
        "PaddlePaddle/PP-OCRv6_small_det",
        "PaddlePaddle/PP-OCRv6_small_rec",
      ]),
    );
    expect(economyTasks.map((task) => task.repo)).not.toContain(
      "PaddlePaddle/PaddleOCR-VL-1.6",
    );
    expect(minimumTasks.map((task) => task.repo)).toEqual(
      expect.arrayContaining([
        "PaddlePaddle/PP-OCRv6_small_det",
        "PaddlePaddle/PP-OCRv6_tiny_rec",
      ]),
    );
    expect(
      minimumTasks.find(
        (task) =>
          task.repo === "PaddlePaddle/PP-OCRv6_tiny_rec" &&
          task.file === "inference.pdiparams",
      ),
    ).toMatchObject({
      revision: "0736086f72f666350ebcdc0c3a504eeac89cdfad",
      expectedSha256:
        "bb2f8f54d1e25f28c71b6fa4fe23f5940e159cae27fbee96155c99f822156e57",
    });
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
    expect(rocmBatches).toHaveLength(5);
    expect(rocmBatches[0]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("rocm_sdk_core-7.2.1"),
        expect.stringContaining("rocm_sdk_devel-7.2.1"),
        expect.stringContaining("rocm_sdk_libraries_custom-7.2.1"),
      ]),
    );
    expect(rocmBatches[0].join(" ")).not.toContain("rocm-7.2.1.tar.gz");
    expect(rocmBatches[1]).toEqual(
      expect.arrayContaining([expect.stringContaining("rocm-7.2.1.tar.gz")]),
    );
    expect(rocmBatches[2]).toEqual(
      expect.arrayContaining([
        "filelock",
        expect.stringContaining("typing-extensions"),
        "setuptools",
        expect.stringContaining("sympy"),
        expect.stringContaining("networkx"),
        "jinja2",
        expect.stringContaining("fsspec"),
        "numpy",
        "pillow",
      ]),
    );
    expect(rocmBatches[3]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("torch-2.9.1%2Brocm7.2.1"),
        expect.stringContaining("torchaudio-2.9.1%2Brocm7.2.1"),
        expect.stringContaining("torchvision-0.24.1%2Brocm7.2.1"),
      ]),
    );
    expect(rocmBatches[4]).toEqual([
      "paddleocr==3.7.0",
      "transformers>=5.10.0",
      "safetensors>=0.6.2",
    ]);
    expect(rocmBatches.flat().join(" ")).not.toContain("paddlepaddle-gpu");
    expect(rocmBatches.flat().join(" ")).not.toContain("/cu126/");
    expect(rocmBatches.flat().join(" ")).not.toContain("/cu129/");
    expect(env.MANGA_TRANSLATOR_OCR_GPU_BACKEND).toBe("rocm-transformers");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE).toBe("gpu:0");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBe("transformers");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE).toBe("float32");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE).toBe("ocr");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_VERSION).toBe("PP-OCRv6");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_ATTN).toBe("eager");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE).toBe("conservative");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN).toBe("1");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT).toBe("1600");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH).toBe("1");
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

  it("keeps ROCm Transformers safe GPU defaults scoped to AMD OCR", () => {
    const previousAttn = process.env.MANGA_TRANSLATOR_PADDLEOCR_ATTN;
    const previousDtype = process.env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE;
    const previousDisableMiopen =
      process.env.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN;
    const previousDetLimit = process.env.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT;
    const previousRecBatch = process.env.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH;
    const previousMergeMode = process.env.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE;
    try {
      const rocmEnv = buildOcrRuntimeEnv({
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
      });

      expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE).toBe("ocr");
      expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBe("transformers");
      expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE).toBe("float32");
      expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_VERSION).toBe("PP-OCRv6");
      expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_ATTN).toBe("eager");
      expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE).toBe(
        "conservative",
      );
      expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN).toBe("1");
      expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT).toBe("1600");
      expect(rocmEnv.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH).toBe("1");
      expect(
        buildOcrRuntimeEnv({ ocrDevice: "cpu" })
          .MANGA_TRANSLATOR_PADDLEOCR_ATTN,
      ).toBeUndefined();
      expect(
        buildOcrRuntimeEnv({ ocrDevice: "cpu" })
          .MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE,
      ).toBeUndefined();
      expect(
        buildOcrRuntimeEnv({ ocrDevice: "cpu" })
          .MANGA_TRANSLATOR_PADDLEOCR_ENGINE,
      ).toBeUndefined();
      expect(buildOcrRuntimeEnv({ ocrDevice: "cpu" }).OMP_NUM_THREADS).toBe(
        "2",
      );
      expect(buildOcrRuntimeEnv({ ocrDevice: "cpu" }).MKL_NUM_THREADS).toBe(
        "2",
      );
      expect(
        buildOcrRuntimeEnv({ ocrDevice: "cpu", ocrWorkerThreads: 3 })
          .OMP_NUM_THREADS,
      ).toBe("3");
      expect(
        buildOcrRuntimeEnv({ ocrDevice: "cpu" })
          .MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN,
      ).toBeUndefined();
      const cudaEnv = buildOcrRuntimeEnv({
        ocrDevice: "gpu",
        ocrGpuBackend: "cuda",
      });
      expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_ATTN).toBeUndefined();
      expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE).toBeUndefined();
      expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBeUndefined();
      expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE).toBeUndefined();
      expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_VERSION).toBeUndefined();
      expect(cudaEnv.OMP_NUM_THREADS).toBeUndefined();
      expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE).toBeUndefined();
      expect(cudaEnv.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN).toBeUndefined();

      process.env.MANGA_TRANSLATOR_PADDLEOCR_ATTN = "sdpa";
      process.env.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE = "none";
      process.env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE = "float16";
      process.env.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN = "0";
      process.env.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT = "960";
      process.env.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH = "2";
      const overriddenRocmEnv = buildOcrRuntimeEnv({
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
      });
      expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE).toBe(
        "float16",
      );
      expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_ATTN).toBe("sdpa");
      expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE).toBe(
        "none",
      );
      expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN).toBe(
        "0",
      );
      expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT).toBe(
        "960",
      );
      expect(overriddenRocmEnv.MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH).toBe("2");
    } finally {
      restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_ATTN", previousAttn);
      restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE", previousDtype);
      restoreEnv(
        "MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN",
        previousDisableMiopen,
      );
      restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT", previousDetLimit);
      restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH", previousRecBatch);
      restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE", previousMergeMode);
    }
  });

  it("hardens the ROCm OCR child environment against VRAM fragmentation", () => {
    const previousAllocConf = process.env.PYTORCH_HIP_ALLOC_CONF;
    const previousVisibleDevices = process.env.HIP_VISIBLE_DEVICES;
    try {
      delete process.env.PYTORCH_HIP_ALLOC_CONF;
      delete process.env.HIP_VISIBLE_DEVICES;
      const rocmEnv = buildOcrRuntimeEnv({
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
      });
      expect(rocmEnv.PYTORCH_HIP_ALLOC_CONF).toBe(
        "garbage_collection_threshold:0.8,max_split_size_mb:512",
      );
      expect(
        buildOcrRuntimeEnv({ ocrDevice: "cpu" }).PYTORCH_HIP_ALLOC_CONF,
      ).toBeUndefined();
      expect(
        buildOcrRuntimeEnv({ ocrDevice: "gpu", ocrGpuBackend: "cuda" })
          .PYTORCH_HIP_ALLOC_CONF,
      ).toBeUndefined();

      process.env.PYTORCH_HIP_ALLOC_CONF = "max_split_size_mb:128";
      process.env.HIP_VISIBLE_DEVICES = "1";
      const overriddenEnv = buildOcrRuntimeEnv({
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
      });
      expect(overriddenEnv.PYTORCH_HIP_ALLOC_CONF).toBe(
        "max_split_size_mb:128",
      );
      expect(overriddenEnv.HIP_VISIBLE_DEVICES).toBe("1");
      expect(
        buildOcrRuntimeEnv({ ocrDevice: "cpu" }).HIP_VISIBLE_DEVICES,
      ).toBeUndefined();
    } finally {
      restoreEnv("PYTORCH_HIP_ALLOC_CONF", previousAllocConf);
      restoreEnv("HIP_VISIBLE_DEVICES", previousVisibleDevices);
    }
  });

  it("reruns OCR commands on CPU when ocrDeviceOverride is set", () => {
    expect(resolveEffectiveOcrDevice({ ocrDevice: "gpu" })).toBe("gpu:0");
    expect(
      resolveEffectiveOcrDevice({ ocrDevice: "gpu", ocrDeviceOverride: "cpu" }),
    ).toBe("cpu");
    expect(resolveEffectiveOcrDevice({ ocrDevice: "cpu" })).toBe("cpu");

    const runtime = { pythonPath: "python" };
    const gpuCommand = buildOcrBboxBatchCommand(
      { ocrDevice: "gpu", ocrGpuBackend: "rocm-transformers" },
      "C:/batch.json",
      runtime,
    );
    expect(gpuCommand).toContain('--device "gpu:0"');
    const fallbackCommand = buildOcrBboxBatchCommand(
      {
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
        ocrDeviceOverride: "cpu",
      },
      "C:/batch.json",
      runtime,
    );
    expect(fallbackCommand).toContain('--device "cpu"');
    // The transformers engine arguments stay tied to the configured device so
    // the GPU (rocm) runtime keeps working during a CPU fallback rerun.
    expect(fallbackCommand).toContain('--engine "transformers"');
    const singleFallbackCommand = buildOcrBboxCommand(
      {
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
        ocrDeviceOverride: "cpu",
        imagePath: "C:/page.png",
      },
      "paddleocr-vl",
      "C:/out.json",
      runtime,
    );
    expect(singleFallbackCommand).toContain('--device "cpu"');
    expect(
      buildOcrRuntimeEnv({
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
        ocrDeviceOverride: "cpu",
      }).MANGA_TRANSLATOR_PADDLEOCR_DEVICE,
    ).toBe("cpu");
  });

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
      buildPaddleOcrGpuFailureMessage(new Error("something odd"), rocmOptions),
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

  it("downgrades VL-mode CPU fallbacks to the PP-OCRv6 text-line path", () => {
    const vlFallback = buildCpuFallbackOcrOptions({
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
      ocrBboxMode: "vl",
      ocrMergeMode: "legacy",
    });
    expect(vlFallback.ocrDeviceOverride).toBe("cpu");
    expect(vlFallback.ocrBboxMode).toBe("ocr");
    expect(vlFallback.ocrMergeMode).toBe("conservative");
    expect(vlFallback.ocrVersion).toBe("PP-OCRv6");

    // Unset mode defaults to VL on the CUDA path, so it is downgraded too.
    const implicitVlFallback = buildCpuFallbackOcrOptions({
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
    });
    expect(implicitVlFallback.ocrBboxMode).toBe("ocr");

    // The rocm-transformers path never runs VL, so its mode stays untouched.
    const rocmFallback = buildCpuFallbackOcrOptions({
      ocrDevice: "gpu",
      ocrGpuBackend: "rocm-transformers",
      ocrBboxMode: "ocr",
      ocrEngine: "transformers",
    });
    expect(rocmFallback.ocrDeviceOverride).toBe("cpu");
    expect(rocmFallback.ocrBboxMode).toBe("ocr");
    expect(rocmFallback.ocrEngine).toBe("transformers");
    expect(rocmFallback.ocrMergeMode).toBeUndefined();
  });

  it("resumes a failed GPU OCR batch on CPU and keeps completed pages", async () => {
    const outputDir = createTempDir("ocr-gpu-fallback-");
    const commandBatchPaths = new Map<string, string>();
    const commandOptions: Array<Record<string, unknown>> = [];
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
        buildOcrBboxBatchCommand(options, batchPath) {
          commandOptions.push({ ...options });
          const command = `ocr-gpu-fallback-${++commandIndex}`;
          commandBatchPaths.set(command, batchPath);
          return command;
        },
        async runShellCommand(command, options) {
          const batchPath = commandBatchPaths.get(command);
          if (!batchPath) {
            throw new Error(`Missing batch path for ${command}`);
          }
          const batch = JSON.parse(readFileSync(batchPath, "utf8")) as {
            items: Array<{ image: string; output: string }>;
          };
          if (command === "ocr-gpu-fallback-1") {
            // GPU run finishes page 1, then the HIP runtime dies.
            writeFileSync(
              batch.items[0].output,
              JSON.stringify([
                { label: "text", bbox: [10, 20, 40, 60], text: "日本語" },
              ]),
              "utf8",
            );
            options.onOutput?.(
              JSON.stringify({ phase: "done", index: 1, total: 3, count: 1 }),
            );
            throw new Error("hipErrorOutOfMemory: HIP out of memory");
          }
          // CPU resume run: page 2 succeeds, page 3 stays failed (no output).
          writeFileSync(
            batch.items[0].output,
            JSON.stringify([
              { label: "text", bbox: [11, 21, 41, 61], text: "日本語" },
            ]),
            "utf8",
          );
          return { stdout: "", stderr: "cpu page failed" };
        },
      },
      async ({
        collectOcrBboxHintsBatch,
        isOcrGpuDisabledForSession,
        resetOcrGpuSessionState,
      }) => {
        const pages = Array.from({ length: 3 }, (_, index) => ({
          imagePath: join(outputDir, `page-${index + 1}.png`),
          outputDir: join(outputDir, `page-${index + 1}`),
          imageWidth: 100,
          imageHeight: 100,
          ocrBboxProvider: "paddleocr-vl",
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
        }));
        const results = await collectOcrBboxHintsBatch(pages);

        expect(results).toHaveLength(3);
        expect(results[0]?.hints).toHaveLength(1);
        expect(results[0]?.diagnostics).toContainEqual(
          expect.objectContaining({ resumedFrom: "gpu" }),
        );
        expect(results[1]?.hints).toHaveLength(1);
        expect(results[2]?.hints).toHaveLength(0);
        expect(results[2]?.noTextDetected).toBe(false);
        expect(results[2]?.diagnostics).toContainEqual(
          expect.objectContaining({ reason: "page-ocr-failed" }),
        );
        expect(isOcrGpuDisabledForSession()).toBe(true);
        resetOcrGpuSessionState();
      },
    );

    expect(commandIndex).toBe(2);
    expect(commandOptions[0]?.ocrDeviceOverride).toBeUndefined();
    expect(commandOptions[1]?.ocrDeviceOverride).toBe("cpu");
  });

  it("prepares build tooling before OCR package installs", () => {
    const command = buildOcrPipBuildToolUpgradeCommand(
      "C:/Python/python.exe",
      '--cache-dir "C:/ocr/pip-cache" --progress-bar raw',
    );

    expect(command).toContain("-m pip install --upgrade");
    expect(command).toContain("pip");
    expect(command).toContain("setuptools");
    expect(command).toContain("wheel");
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
      "transformers>=5.10.0",
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
      '--cache-dir "C:/ocr/c" --progress-bar raw',
    );
    const rocmTorchCommand = buildOcrPipInstallCommand(
      "C:/Python/python.exe",
      rocmTorchWheels,
      "C:/ocr/p",
      options,
      '--cache-dir "C:/ocr/c" --progress-bar raw',
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
    expect(rocmMetaCommand).toContain('"--no-build-isolation"');
    expect(rocmMetaCommand).toContain('"--no-deps"');
    expect(rocmMetaCommand).toContain('--target "C:/ocr/p"');
    expect(rocmTorchCommand).toContain('"--no-deps"');
    expect(rocmTorchCommand).not.toContain('"--no-build-isolation"');
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

      expect(isWindowsRocmOcrRuntimePathShortEnough(oldRuntimeDir)).toBe(false);
      expect(runtimeDir).toBe(
        join("C:\\Users\\taepotaepo\\AppData\\Local", "MGTOCR", "r721"),
      );
      expect(packageDir).toBe(join(runtimeDir, "p"));
      expect(tempDir).toBe(join(runtimeDir, "t"));
      expect(pipCacheDir).toBe(join(runtimeDir, "c"));
      expect(userBaseDir).toBe(join(runtimeDir, "u"));
      expect(venvDir).toBe(join(runtimeDir, "v"));
      expect(longPipTempEntry.length).toBeLessThan(252);
      expect(packageDir).not.toContain("python-packages-gpu-rocm-transformers");
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
      `--cache-dir ${join(runtimeDir, "c")} --progress-bar raw`,
    );

    expect(env.TMP).toBe(join(runtimeDir, "t"));
    expect(env.TEMP).toBe(join(runtimeDir, "t"));
    expect(env.PIP_CACHE_DIR).toBe(join(runtimeDir, "c"));
    expect(env.PYTHONUSERBASE).toBe(join(runtimeDir, "u"));
    expect(env.PYTHONPATH).toBe(packageDir);
    expect(command).toContain(`--target "${packageDir}"`);
    expect(command).not.toContain("data\\ocr-runtime");
    expect(command).not.toContain("python-packages-gpu-rocm-transformers");
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

    expect(cpuCommand).not.toContain("--bbox-mode");
    expect(cpuCommand).not.toContain("--engine");
    expect(cudaCommand).not.toContain("--bbox-mode");
    expect(cudaCommand).not.toContain("--engine");
    expect(amdCommand).toContain("--bbox-mode");
    expect(amdCommand).toContain("ocr");
    expect(amdCommand).toContain("--engine");
    expect(amdCommand).toContain("transformers");
    expect(amdCommand).toContain("--dtype");
    expect(amdCommand).toContain("float32");
    expect(amdCommand).toContain("--ocr-version");
    expect(amdCommand).toContain("PP-OCRv6");
    expect(amdCommand).toContain("--merge-mode");
    expect(amdCommand).toContain("conservative");
  });

  it("passes smoke OCR presets for economy and full modes", () => {
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
        ocrMergeMode: "conservative",
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
      ocrMergeMode: "conservative",
    });

    expect(economyCommand).toContain("--bbox-mode");
    expect(economyCommand).toContain("ocr");
    expect(economyCommand).toContain("--engine");
    expect(economyCommand).toContain("paddle_static");
    expect(economyCommand).toContain("--text-detection-model-name");
    expect(economyCommand).toContain("PP-OCRv6_small_det");
    expect(economyCommand).toContain("--text-recognition-model-name");
    expect(economyCommand).toContain("PP-OCRv6_small_rec");
    expect(economyCommand).toContain("--merge-mode");
    expect(economyCommand).toContain("conservative");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE).toBe("ocr");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_ENGINE).toBe("paddle_static");
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME).toBe(
      "PP-OCRv6_small_det",
    );
    expect(env.MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME).toBe(
      "PP-OCRv6_small_rec",
    );
    expect(fullCommand).toContain("--bbox-mode");
    expect(fullCommand).toContain("vl");
    expect(fullCommand).toContain("--ocr-version");
    expect(fullCommand).toContain("PP-OCRv6");
    expect(fullCommand).toContain("--merge-mode");
    expect(fullCommand).toContain("legacy");
    expect(fullCommand).not.toContain("--engine");
    expect(fullCommand).not.toContain("--text-detection-model-name");
    expect(fullCommand).not.toContain("--text-recognition-model-name");
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
      expect(flat).toContain("transformers>=5.10.0");
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

  it("splits CPU PaddleOCR batches across workers with two threads each", async () => {
    const outputDir = createTempDir("ocr-cpu-parallel-");
    const commandBatchPaths = new Map<string, string>();
    const commandEnvs: Array<Record<string, string> | undefined> = [];
    const batchSizes: number[] = [];
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
        buildOcrBboxBatchCommand(_options, batchPath) {
          const command = `ocr-cpu-batch-${++commandIndex}`;
          commandBatchPaths.set(command, batchPath);
          return command;
        },
        async runShellCommand(command, options) {
          commandEnvs.push(options.env);
          const batchPath = commandBatchPaths.get(command);
          if (!batchPath) {
            throw new Error(`Missing batch path for ${command}`);
          }
          const batch = JSON.parse(readFileSync(batchPath, "utf8")) as {
            items: Array<{ output: string }>;
          };
          batchSizes.push(batch.items.length);
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
          return { stdout: "", stderr: "" };
        },
      },
      async ({ collectOcrBboxHintsBatch }) => {
        const pages = Array.from({ length: 5 }, (_, index) => ({
          imagePath: join(outputDir, `page-${index + 1}.png`),
          outputDir: join(outputDir, `page-${index + 1}`),
          imageWidth: 100,
          imageHeight: 100,
          ocrBboxProvider: "paddleocr-vl",
          ocrDevice: "cpu",
          ocrCpuWorkers: 2,
          ocrCpuWorkerMinFreeRamPercent: 0,
          ocrCpuWorkerStartDelayMs: 0,
        }));
        const results = await collectOcrBboxHintsBatch(pages);

        expect(results).toHaveLength(5);
        expect(results.every((result) => result.hints.length === 1)).toBe(true);
      },
    );

    expect(commandIndex).toBe(2);
    expect(batchSizes).toEqual([3, 2]);
    expect(commandEnvs).toHaveLength(2);
    for (const env of commandEnvs) {
      expect(env?.OMP_NUM_THREADS).toBe("2");
      expect(env?.MKL_NUM_THREADS).toBe("2");
      expect(env?.FLAGS_cpu_math_library_num_threads).toBe("2");
    }
  });

  it("uses a 20 percent free-RAM floor for extra CPU OCR workers", () => {
    expect(resolveOcrCpuWorkerMinFreeRamRatio()).toBe(0.2);
    expect(
      resolveOcrCpuWorkerMinFreeRamRatio({
        ocrCpuWorkerMinFreeRamPercent: 0,
      }),
    ).toBe(0);
    expect(
      resolveOcrCpuWorkerMinFreeRamRatio({
        ocrCpuWorkerMinFreeRamPercent: 35,
      }),
    ).toBe(0.35);
    expect(
      hasOcrCpuWorkerRamHeadroom(
        { freeBytes: 199, totalBytes: 1000, freeRatio: 0.199 },
        0.2,
      ),
    ).toBe(false);
    expect(
      hasOcrCpuWorkerRamHeadroom(
        { freeBytes: 200, totalBytes: 1000, freeRatio: 0.2 },
        0.2,
      ),
    ).toBe(true);
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
