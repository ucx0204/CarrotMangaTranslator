import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

const runtimeHelpers = require("../src/main/runtime/simple-page-translate.cjs") as {
  buildLaunchArgs: (options: { [key: string]: unknown }) => string[];
  buildMessages: (
    options: { [key: string]: unknown },
    imageVariants: Array<{ role: string; dataUrl: string; width?: number; height?: number; originalWidth?: number; originalHeight?: number }>
  ) => Array<{
    role: string;
    content: Array<{ type: string; text?: string; image_url?: { url: string } }>;
  }>;
  buildResponsesRequestBody: (
    options: { [key: string]: unknown },
    imageVariants: Array<{ role: string; dataUrl: string; width?: number; height?: number; originalWidth?: number; originalHeight?: number }>
  ) => {
    model: string;
    instructions: string;
    input: Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: string; detail?: string }> }>;
    reasoning: { effort: string };
    stream: boolean;
    store: boolean;
  };
  buildOcrRuntimeEnv: (
    options: { [key: string]: unknown },
    runtime?: { runtimeDir?: string; packageDir?: string; includePackageDir?: boolean }
  ) => Record<string, string>;
  buildLlamaServerEnv: (serverPath: string, options: { [key: string]: unknown }) => Record<string, string>;
  buildPaddleOcrImportCheckScript: (options?: { [key: string]: unknown }) => string;
  getOverlayPrompt: (
    options: { [key: string]: unknown },
    imageVariants: Array<{ role: string; dataUrl?: string; width?: number; height?: number; originalWidth?: number; originalHeight?: number }>
  ) => string;
  collectOcrBboxHints: (options: { [key: string]: unknown }) => Promise<{
    hints: Array<{ x1: number; y1: number; x2: number; y2: number; ocrText?: string }>;
    diagnostics: unknown[];
    noTextDetected: boolean;
    textEvidenceCount: number;
  }>;
  collectRequiredHfDownloads: (options: { [key: string]: unknown }) => Array<{ kind: string; file: string; destination: string }>;
  collectRequiredPaddleOcrModelDownloads: (
    options: { [key: string]: unknown },
    runtime?: { runtimeDir?: string }
  ) => Array<{ kind: string; repo: string; file: string; destination: string; url: string }>;
  extractModelOutputText: (parsed: unknown) => string;
  inspectModelLaunch: (options: { [key: string]: unknown }) => { launchMode: string; model?: string; reasoningEffort?: string };
  isModelCached: (options: { [key: string]: unknown }) => boolean;
  parseOcrBatchProgressLine: (line: string) => { index: number; total: number; count: number } | null;
  parsePaddleModelFetchProgress: (line: string) => { totalFiles: number; currentFiles: number | null; percent: number | null } | null;
  parsePipRawProgress: (line: string) => { current: number; total: number } | null;
  parseResponsesSseText: (rawText: string) => { outputText: string; eventCount: number; rawResponse: unknown };
  requestTranslation: (server: { baseUrl: string }, options: { [key: string]: unknown }) => Promise<{ outputText: string; rawResponse: unknown; requestBody: Record<string, unknown> }>;
  resolveOcrGpuCudaTag: (options?: { [key: string]: unknown }) => string;
  resolveOcrGpuPackageIndexUrl: (options?: { [key: string]: unknown }) => string;
  resolveOcrPipInstallBatches: (options?: { [key: string]: unknown }) => string[][];
  resolvePaddleOcrImportCheckTimeoutMs: (options?: { [key: string]: unknown }) => number;
  resolveFfmpegPath: (options: { [key: string]: unknown }) => string;
  resolveLlamaCppCacheDir: (options?: { [key: string]: unknown }) => string | null;
  resolveOcrBboxTimeoutMs: (pageCount?: number) => number;
  resolveOcrInstallBatchProgressRanges: (batches: string[][], start: number, end: number) => Array<{ start: number; end: number }>;
  resolveManagedHfFilePath: (options: { [key: string]: unknown }, repo: string, file: string) => string | null;
};
const llamaRuntimeResolver = require("../src/main/runtime/resolve-llama-runtime.cjs") as {
  bundledServerCandidates: (toolsDir: string) => string[];
  resolveBundledServerPath: (toolsDir: string) => string;
};
const {
  buildLaunchArgs,
  buildMessages,
  buildOcrRuntimeEnv,
  buildLlamaServerEnv,
  buildPaddleOcrImportCheckScript,
  buildResponsesRequestBody,
  collectOcrBboxHints,
  collectRequiredHfDownloads,
  collectRequiredPaddleOcrModelDownloads,
  getOverlayPrompt,
  extractModelOutputText,
  inspectModelLaunch,
  isModelCached,
  parseOcrBatchProgressLine,
  parsePaddleModelFetchProgress,
  parsePipRawProgress,
  resolveOcrInstallBatchProgressRanges,
  resolveManagedHfFilePath,
  resolveOcrBboxTimeoutMs,
  resolveFfmpegPath,
  resolveLlamaCppCacheDir,
  parseResponsesSseText,
  requestTranslation,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrPipInstallBatches,
  resolvePaddleOcrImportCheckTimeoutMs
} = runtimeHelpers;
const { bundledServerCandidates, resolveBundledServerPath } = llamaRuntimeResolver;

const tempDirs: string[] = [];
const DEFAULT_31B_REPO = "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF";
const DEFAULT_31B_FILE = "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.i1-IQ3_S.gguf";
const DEFAULT_MMPROJ_REPO = "mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF";
const DEFAULT_MMPROJ_FILE = "gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.mmproj-f16.gguf";
const DEFAULT_DRAFT_REPO = "Anbeeld/gemma-4-31B-it-DFlash-GGUF";
const DEFAULT_DRAFT_FILE = "gemma4-31b-it-dflash-IQ4_XS.gguf";
const DEFAULT_26B_REPO = "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-i1-GGUF";
const DEFAULT_26B_FILE = "gemma-4-26B-A4B-it-ultra-uncensored-heretic.i1-IQ3_S.gguf";
const DEFAULT_26B_MMPROJ_REPO = "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF";
const DEFAULT_26B_MMPROJ_FILE = "gemma-4-26B-A4B-it-ultra-uncensored-heretic.mmproj-Q8_0.gguf";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function writeCachedAssets({
  hubCacheDir,
  repoId,
  snapshot,
  modelFile,
  includeMmproj = true
}: {
  hubCacheDir: string;
  repoId: string;
  snapshot: string;
  modelFile: string;
  includeMmproj?: boolean;
}): string {
  const snapshotDir = join(hubCacheDir, `models--${repoId.replace(/\//g, "--")}`, "snapshots", snapshot);
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(snapshotDir, modelFile), "model");
  if (includeMmproj) {
    writeFileSync(join(snapshotDir, "mmproj-BF16.gguf"), "mmproj");
  }
  return snapshotDir;
}

describe("runtime model launch helpers", () => {
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
    const runtimeDir = join(toolsDir, "llama-b8833-cuda12.4");
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
      total: 1048576
    });
    expect(parsePipRawProgress("Collecting paddleocr")).toBeNull();
  });

  it("parses OCR batch progress JSON lines", () => {
    expect(parseOcrBatchProgressLine('{"index":2,"total":65,"output":"page.json","count":14}')).toEqual({
      phase: "done",
      index: 2,
      total: 65,
      count: 14
    });
    expect(parseOcrBatchProgressLine('{"phase":"start","index":3,"total":65,"output":"page.json","count":0}')).toEqual({
      phase: "start",
      index: 3,
      total: 65,
      count: 0
    });
    expect(parseOcrBatchProgressLine('{"items":[],"count":65}')).toBeNull();
    expect(parseOcrBatchProgressLine("[paddleocr] warmup")).toBeNull();
  });

  it("parses Paddle model fetch progress lines", () => {
    expect(parsePaddleModelFetchProgress("Fetching 19 files: 11%|█ | 2/19 [00:00<00:07, 2.14it/s]")).toEqual({
      totalFiles: 19,
      currentFiles: 2,
      percent: 11
    });
    expect(parsePaddleModelFetchProgress("Creating model: ('PaddleOCR-VL-1.5-0.9B', None, None)")).toBeNull();
  });

  it("allows slow first-run Paddle model downloads before timing out OCR bbox analysis", () => {
    const previous = process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS;
    delete process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS;
    try {
      expect(resolveOcrBboxTimeoutMs(1)).toBeGreaterThanOrEqual(60 * 60 * 1000);
      expect(resolveOcrBboxTimeoutMs(20)).toBeGreaterThanOrEqual(60 * 60 * 1000);
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

    expect(tasks).toHaveLength(36);
    expect(tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repo: "PaddlePaddle/PP-DocLayoutV3",
        file: "inference.pdiparams",
        destination: join(runtimeDir, "paddlex-cache", "official_models", "PP-DocLayoutV3", "inference.pdiparams")
      }),
      expect.objectContaining({
        repo: "PaddlePaddle/PaddleOCR-VL-1.5",
        file: "model.safetensors",
        destination: join(runtimeDir, "paddlex-cache", "official_models", "PaddleOCR-VL-1.5", "model.safetensors")
      }),
      expect.objectContaining({
        repo: "PaddlePaddle/PP-OCRv5_server_det",
        file: "inference.pdiparams",
        destination: join(runtimeDir, "paddlex-cache", "official_models", "PP-OCRv5_server_det", "inference.pdiparams")
      }),
      expect.objectContaining({
        repo: "PaddlePaddle/PP-OCRv5_server_rec",
        file: "inference.pdiparams",
        destination: join(runtimeDir, "paddlex-cache", "official_models", "PP-OCRv5_server_rec", "inference.pdiparams")
      })
    ]));
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
      const env = buildOcrRuntimeEnv({}, { runtimeDir, includePackageDir: false });
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
        expect(resolveLlamaCppCacheDir()).toBe(join(localAppData, "manga-gemma-translator", "llama.cpp"));
      } else {
        const xdgCacheHome = createTempDir("xdg-cache-");
        process.env.XDG_CACHE_HOME = xdgCacheHome;
        expect(resolveLlamaCppCacheDir()).toBe(join(xdgCacheHome, "manga-gemma-translator", "llama.cpp"));
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
    const serverPath = join(runtimeDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");
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
        llamaCacheDir
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
    const previousPaddleCudaTag = process.env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG;
    const previousOcrGpuCuda = process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA;
    const previousIndexUrl = process.env.MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL;
    const previousPaddleIndexUrl = process.env.MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL;
    delete process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG;
    delete process.env.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG;
    delete process.env.MANGA_TRANSLATOR_OCR_GPU_CUDA;
    delete process.env.MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL;
    delete process.env.MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL;
    try {
      expect(resolveOcrGpuCudaTag({ ocrGpuCudaTag: "cu129" })).toBe("cu129");
      expect(resolveOcrGpuPackageIndexUrl({ ocrGpuCudaTag: "cu129" })).toBe("https://www.paddlepaddle.org.cn/packages/stable/cu129/");
      const env = buildOcrRuntimeEnv({ ocrDevice: "gpu", ocrGpuCudaTag: "cu129" }, { runtimeDir, includePackageDir: false });
      expect(env.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG).toBe("cu129");
      expect(env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE).toBe("gpu:0");
    } finally {
      restoreEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG", previousCudaTag);
      restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG", previousPaddleCudaTag);
      restoreEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA", previousOcrGpuCuda);
      restoreEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL", previousIndexUrl);
      restoreEnv("MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL", previousPaddleIndexUrl);
    }
  });

  it("uses official cu129 Paddle OCR packages and Windows safetensors for RTX 50 GPU OCR runtimes", () => {
    const cu129Batches = resolveOcrPipInstallBatches({ ocrDevice: "gpu", ocrGpuCudaTag: "cu129" });
    const cu126Batches = resolveOcrPipInstallBatches({ ocrDevice: "gpu", ocrGpuCudaTag: "cu126" });
    const cpuBatches = resolveOcrPipInstallBatches({ ocrDevice: "cpu" });

    expect(cu129Batches[0]).toEqual([
      "paddlepaddle-gpu==3.3.1",
      "--index-url",
      "https://www.paddlepaddle.org.cn/packages/stable/cu129/"
    ]);
    expect(cu129Batches[1]).toEqual(["paddleocr[doc-parser]==3.5.0"]);
    if (process.platform === "win32") {
      expect(cu129Batches[2][0]).toBe("--no-deps");
      expect(cu129Batches[2][1]).toBe("--force-reinstall");
      expect(cu129Batches[2][2]).toContain("safetensors-0.6.2.dev0");
    }
    expect(cu126Batches[0]).toEqual([
      "paddlepaddle-gpu==3.3.1",
      "--index-url",
      "https://www.paddlepaddle.org.cn/packages/stable/cu126/"
    ]);
    expect(cu126Batches[1]).toEqual(["paddleocr[doc-parser]==3.5.0"]);
    expect(cpuBatches[0][0]).toBe("paddlepaddle==3.3.1");
    expect(cpuBatches[0][1]).toBe("paddleocr[doc-parser]==3.5.0");
    if (process.platform === "win32") {
      expect(cu126Batches[2][0]).toBe("--no-deps");
      expect(cu126Batches[2][1]).toBe("--force-reinstall");
      expect(cu126Batches[2][2]).toContain("safetensors-0.6.2.dev0");
      expect(cpuBatches[1][0]).toBe("--no-deps");
      expect(cpuBatches[1][1]).toBe("--force-reinstall");
      expect(cpuBatches[1][2]).toContain("safetensors-0.6.2.dev0");
    }
  });

  it("keeps RTX 50 Paddle OCR verification lightweight and gives cu129 more startup time", () => {
    const previous = process.env.MANGA_TRANSLATOR_OCR_IMPORT_TIMEOUT_MS;
    delete process.env.MANGA_TRANSLATOR_OCR_IMPORT_TIMEOUT_MS;
    try {
      const script = buildPaddleOcrImportCheckScript({ ocrDevice: "gpu", ocrGpuCudaTag: "cu129" });
      expect(script).toContain("importlib.util.find_spec");
      expect(script).toContain("import paddle");
      expect(script).toContain("from paddleocr import PaddleOCRVL, PaddleOCR");
      expect(script).not.toContain("import paddle, paddlex, paddleocr");
      expect(script).toContain("paddle.set_device");
      expect(resolvePaddleOcrImportCheckTimeoutMs({ ocrDevice: "gpu", ocrGpuCudaTag: "cu129" })).toBeGreaterThanOrEqual(300000);
      expect(resolvePaddleOcrImportCheckTimeoutMs({ ocrDevice: "gpu", ocrGpuCudaTag: "cu126" })).toBeGreaterThanOrEqual(180000);
      expect(resolvePaddleOcrImportCheckTimeoutMs({ ocrDevice: "cpu" })).toBeGreaterThanOrEqual(120000);
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

    expect(() => resolveFfmpegPath({ toolsDir })).toThrow("Bundled ffmpeg is missing");
  });

  it("streams OCR batch progress without inheriting the first page index during runtime setup", () => {
    const runtimeSource = readFileSync(join(__dirname, "..", "src", "main", "runtime", "simple-page-translate.cjs"), "utf8");
    const paddleSource = readFileSync(join(__dirname, "..", "src", "main", "runtime", "paddleocr-vl-bboxes.py"), "utf8");

    expect(runtimeSource).toContain("const batchOptions = withoutPageProgressOptions(firstOptions)");
    expect(runtimeSource).toContain("await ensurePaddleOcrRuntime(batchOptions)");
    expect(runtimeSource).toContain("emitRuntimeProgress(batchOptions, \"ocr_running\"");
    expect(runtimeSource).toContain("createCommandOutputLineEmitter(onOutput)");
    expect(runtimeSource).toContain("stdoutLines.write(chunk)");
    expect(paddleSource).toContain("flush=True");
  });

  it("treats an explicitly empty OCR hint array as a completed OCR pass", async () => {
    const result = await collectOcrBboxHints({
      ocrBboxHints: [],
      ocrBboxProvider: "none"
    });

    expect(result).toMatchObject({
      hints: [],
      diagnostics: [{ provider: "inline", hintCount: 0 }],
      noTextDetected: true,
      textEvidenceCount: 0
    });
  });

  it("does not skip model analysis when OCR found geometry without readable Japanese transcript", async () => {
    const noEvidence = await collectOcrBboxHints({
      ocrBboxHints: [{ id: 1, label: "text", x1: 10, y1: 20, x2: 80, y2: 90 }]
    });
    const hasEvidence = await collectOcrBboxHints({
      ocrBboxHints: [{ id: 1, label: "text", x1: 10, y1: 20, x2: 80, y2: 90, ocrText: "1998年1月" }]
    });

    expect(noEvidence).toMatchObject({ noTextDetected: false, textEvidenceCount: 0 });
    expect(hasEvidence).toMatchObject({ noTextDetected: false, textEvidenceCount: 1 });
  });

  it("returns a synthetic empty overlay instead of calling a model for no-text OCR pages", async () => {
    const result = await requestTranslation(
      { baseUrl: "http://127.0.0.1:1" },
      {
        label: "blank-page",
        modelProvider: "gemma",
        imageWidth: 1000,
        imageHeight: 1000,
        ocrBboxHints: []
      }
    );

    expect(JSON.parse(result.outputText)).toEqual({ items: [] });
    expect(result.rawResponse).toMatchObject({ skipped: true, reason: "ocr-no-text" });
    expect(result.requestBody).toMatchObject({ noTextDetected: true, ocrTextEvidenceCount: 0 });
  });

  it("weights OCR GPU install batches so one completed download does not imply half the install is done", () => {
    const ranges = resolveOcrInstallBatchProgressRanges(
      [
        ["paddlepaddle-gpu==3.3.1", "--extra-index-url", "https://www.paddlepaddle.org.cn/packages/stable/cu126/"],
        ["paddleocr==3.5.0", "paddlex[ocr]==3.5.2"]
      ],
      0.1,
      0.86
    );

    expect(ranges).toHaveLength(2);
    expect(ranges[0].start).toBeCloseTo(0.1);
    expect(ranges[0].end).toBeGreaterThan(0.36);
    expect(ranges[0].end).toBeLessThan(0.39);
    expect(ranges[1].start).toBeCloseTo(ranges[0].end);
    expect(ranges[1].end).toBeCloseTo(0.86);
  });

  it("treats OpenAI Codex as a remote OAuth-backed endpoint", () => {
    const launch = inspectModelLaunch({
      modelProvider: "openai-codex",
      codexModel: "gpt-5.5",
      codexReasoningEffort: "high"
    });

    expect(launch).toEqual({
      launchMode: "openai-codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      requiresDownload: false
    });
    expect(isModelCached({ modelProvider: "openai-codex" })).toBe(true);
  });

  it("builds Codex Responses requests with input_image data URLs", () => {
    const requestBody = buildResponsesRequestBody(
      {
        modelProvider: "openai-codex",
        codexModel: "gpt-5.5",
        codexReasoningEffort: "xhigh",
        imageWidth: 836,
        imageHeight: 1188
      },
      [{ role: "openai-vision", dataUrl: "data:image/png;base64,abc123", width: 836, height: 1188, originalWidth: 836, originalHeight: 1188 }]
    );

    expect(requestBody.model).toBe("gpt-5.5");
    expect(requestBody.reasoning.effort).toBe("xhigh");
    expect(requestBody.stream).toBe(true);
    expect(requestBody.store).toBe(false);
    expect(requestBody.input[0]?.content.some((part) => part.type === "input_image" && part.image_url === "data:image/png;base64,abc123" && part.detail === "original")).toBe(true);
    expect(requestBody.input[0]?.content[0]).toMatchObject({ type: "input_image", image_url: "data:image/png;base64,abc123" });
    expect(requestBody.input[0]?.content[1]).toMatchObject({ type: "input_text" });
    expect(requestBody).not.toHaveProperty("max_tokens");
  });

  it("uses tight Japanese glyph bbox instructions for Codex Responses requests", () => {
    const requestBody = buildResponsesRequestBody(
      {
        modelProvider: "openai-codex",
        codexModel: "gpt-5.5",
        codexReasoningEffort: "medium",
        imageWidth: 7680,
        imageHeight: 4320
      },
      [{ role: "openai-vision", dataUrl: "data:image/png;base64,abc123", width: 4256, height: 2400, originalWidth: 7680, originalHeight: 4320 }]
    );
    const promptText = requestBody.input[0]?.content.find((part) => part.type === "input_text" && part.text?.includes("# Task"))?.text ?? "";
    const imageDescription = requestBody.input[0]?.content.find((part) => part.type === "input_text" && part.text?.includes("Image 1:"))?.text ?? "";

    expect(requestBody.instructions).toContain("Geometry accuracy comes before Korean text fit");
    expect(requestBody.instructions).toContain("Never merge separate speech bubbles, including touching or stacked balloon lobes.");
    expect(promptText).toContain("Detect every visible Japanese text group");
    expect(promptText).toContain("You are given one full-page Japanese manga image.");
    expect(promptText).toContain("fontSize is the apparent Japanese glyph size in Image 1 pixels");
    expect(promptText).toContain("x1, y1, x2, y2 describe the tight rectangle corners of the visible Japanese glyph ink and its outline.");
    expect(promptText).toContain("Each speech bubble is one dialogue item.");
    expect(promptText).toContain("If two white balloon lobes touch, overlap, stack vertically, or connect through a narrow neck");
    expect(promptText).toContain("Never enlarge, shift, or reshape the rectangle");
    expect(promptText).toContain("The original page is 7680x4320 px.");
    expect(promptText).toContain("Image 1 was prepared before the API call to match the OpenAI detail: original vision frame");
    expect(promptText).toContain("Return x1, y1, x2, y2 as integer pixel coordinates in that 4256x2400 Image 1 frame.");
    expect(requestBody.input[0]?.content.find((part) => part.type === "input_text" && part.text?.includes("# Task"))?.text).not.toContain("Return x, y, w, h as normalized 0..1000");
    expect(imageDescription).toContain("prepared for OpenAI detail: original vision");
    expect(promptText).toContain("Do not return width/height, original-page pixels, normalized 0..1000 coordinates, viewport coordinates, crop coordinates, tile coordinates, or model-internal coordinates.");
  });

  it("uses OCR bbox candidates as single-pass geometry hints", () => {
    const options = {
      modelProvider: "openai-codex",
      imageWidth: 836,
      imageHeight: 1188,
      ocrBboxHints: [
        { id: 1, label: "text", x1: 67, y1: 589, x2: 267, y2: 760, ocrText: "いえ…資金はこちらも" },
        { id: 2, label: "text", x1: 83, y1: 767, x2: 239, y2: 1029, ocrText: "モリーダ村に支店を置く" }
      ]
    };
    const variants = [{ role: "openai-vision", dataUrl: "data:image/png;base64,abc123", width: 836, height: 1188, originalWidth: 836, originalHeight: 1188 }];
    const prompt = getOverlayPrompt(options, variants);

    expect(prompt).toContain("# OCR bbox candidates");
    expect(prompt).toContain("low-trust OCR text hints for slot matching only");
    expect(prompt).toContain("Use Image 1 as the authority");
    expect(prompt).toContain("Treat each candidate as a locked geometry slot.");
    expect(prompt).toContain("Required candidate ids: 1, 2.");
    expect(prompt).toContain('candidate 1: label:text x1:67 y1:589 x2:267 y2:760 ocrText:"いえ…資金はこちらも"');
    expect(prompt).toContain('candidate 2: label:text x1:83 y1:767 x2:239 y2:1029 ocrText:"モリーダ村に支店を置く"');
    expect(prompt).toContain("Do not merge two candidates into one record");
    expect(prompt).toContain("add a new record with id greater than 2");
    expect(prompt).not.toContain("Find one anchor point");
  });

  it("uses container-level grouping for selected-region crop translation", () => {
    const prompt = getOverlayPrompt(
      {
        regionCropMode: true,
        skipOcrBboxHints: true,
        imageWidth: 420,
        imageHeight: 320
      },
      [{ role: "original", dataUrl: "data:image/png;base64,abc123", width: 420, height: 320, originalWidth: 420, originalHeight: 320 }]
    );

    expect(prompt).toContain("You are given one user-selected crop from a Japanese manga page.");
    expect(prompt).toContain("# Selected region grouping");
    expect(prompt).toContain("Do not treat the whole crop as one text item.");
    expect(prompt).toContain("If the crop contains one speech bubble or one caption plate, output exactly one record");
    expect(prompt).toContain("Inside one speech bubble, never split by Japanese vertical column, text line, word, sentence fragment, punctuation gap, or line break.");
    expect(prompt).toContain("jp must include all columns in natural Japanese reading order");
  });

  it("normalizes bbox hint JSON with low-trust OCR text", async () => {
    const dir = createTempDir("ocr-hints-");
    const hintPath = join(dir, "hints.json");
    writeFileSync(
      hintPath,
      JSON.stringify({
        source: "paddleocr-vl",
        coordinateSpace: "pixels",
        width: 836,
        height: 1188,
        items: [
          { label: "text", bbox: [67, 589, 267, 760], content: "いえ…" },
          { label: "image", bbox: [0, 0, 100, 100], content: "ignored" }
        ]
      }),
      "utf8"
    );

    const result = await collectOcrBboxHints({
      imageWidth: 836,
      imageHeight: 1188,
      ocrBboxHintsPath: hintPath
    });

    expect(result.hints).toHaveLength(1);
    expect(result.hints[0]).toMatchObject({ x1: 67, y1: 589, x2: 267, y2: 760, ocrText: "いえ…" });
  });

  it("uses the same tight Japanese glyph bbox prompt for Gemma chat requests", () => {
    const messages = buildMessages(
      {
        modelProvider: "gemma",
        imageWidth: 836,
        imageHeight: 1188
      },
      [{ role: "original", dataUrl: "data:image/png;base64,abc123" }]
    );
    const systemText = messages[0]?.content.find((part) => part.type === "text")?.text ?? "";
    const userPrompt = messages[1]?.content.find((part) => part.type === "text" && part.text?.includes("# Task"))?.text ?? "";

    expect(systemText).toContain("Geometry accuracy comes before Korean text fit");
    expect(messages[1]?.content[0]).toMatchObject({ type: "image_url" });
    expect(messages[1]?.content[1]).toMatchObject({ type: "text" });
    expect(userPrompt).toContain("Detect every visible Japanese text group");
    expect(userPrompt).toContain("Return x1, y1, x2, y2 as normalized 0..1000");
    expect(userPrompt).toContain("direction, angle, fontSize");
    expect(userPrompt).toContain("For SFX, box only the sound-effect glyph strokes");
    expect(userPrompt).not.toContain("speech bubble, narration box, name call, or sound-effect block");
  });

  it("extracts text from Responses API output payloads", () => {
    expect(
      extractModelOutputText({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "id: 1\nko: 테스트"
              }
            ]
          }
        ]
      })
    ).toBe("id: 1\nko: 테스트");
  });

  it("collects Responses API streaming text deltas", () => {
    const parsed = parseResponsesSseText(
      [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"id: 1"}',
        "",
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"\\nko: 테스트"}',
        "",
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}',
        "",
        "data: [DONE]",
        ""
      ].join("\n")
    );

    expect(parsed.outputText).toBe("id: 1\nko: 테스트");
    expect(parsed.eventCount).toBe(3);
  });

  it("launches an explicitly configured local GGUF without Hugging Face flags", () => {
    const localDir = createTempDir("local-model-");
    const modelPath = join(localDir, "custom-vision-model.gguf");
    const mmprojPath = join(localDir, "mmproj-BF16.gguf");
    writeFileSync(modelPath, "model");
    writeFileSync(mmprojPath, "mmproj");

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelSource: "local",
      localModelPath: modelPath,
      localMmprojPath: mmprojPath
    });

    expect(args).toContain("-m");
    expect(args).toContain(modelPath);
    expect(args).toContain("--mmproj");
    expect(args).toContain(mmprojPath);
    expect(args).toContain("--no-mmproj-offload");
    expect(args).not.toContain("--mmproj-offload");
    expect(args).toContain("--no-warmup");
    expect(args).not.toContain("--n-cpu-moe");
    expect(args).not.toContain("--chat-template-kwargs");
    expect(args.slice(args.indexOf("--repeat-penalty"), args.indexOf("--repeat-penalty") + 2)).toEqual([
      "--repeat-penalty",
      "1.08"
    ]);
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(isModelCached({ modelSource: "local", localModelPath: modelPath })).toBe(true);
  });

  it("passes VRAM economy cache options to llama-server without clipping image tokens", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 1024,
      ctx: 8192,
      batch: 1024,
      ubatch: 1024,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      kvOffload: true,
      mmprojOffload: false,
      enableMetrics: true,
      enablePerf: true,
      imageMinTokens: 1024,
      imageMaxTokens: 1024,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE
    });

    expect(args.slice(args.indexOf("--cache-type-k"), args.indexOf("--cache-type-k") + 2)).toEqual([
      "--cache-type-k",
      "q4_0"
    ]);
    expect(args.slice(args.indexOf("--cache-type-v"), args.indexOf("--cache-type-v") + 2)).toEqual([
      "--cache-type-v",
      "q4_0"
    ]);
    expect(args.slice(args.indexOf("--ctx-checkpoints"), args.indexOf("--ctx-checkpoints") + 2)).toEqual([
      "--ctx-checkpoints",
      "0"
    ]);
    expect(args).toContain("--no-mmproj-offload");
    expect(args).toContain("--metrics");
    expect(args).toContain("--perf");
    expect(args).toContain("--kv-offload");
    expect(args).toContain("--kv-unified");
    expect(args).toContain("--jinja");
    expect(args).toContain("--no-mmap");
    expect(args).toContain("--mlock");
    expect(args).toContain("--no-host");
    expect(args).not.toContain("--no-kv-offload");
    expect(args).not.toContain("--fit");
    expect(args).not.toContain("--no-cache-prompt");
    expect(args).not.toContain("--no-warmup");
    expect(args.slice(args.indexOf("-ngl"), args.indexOf("-ngl") + 2)).toEqual([
      "-ngl",
      "all"
    ]);
    expect(args.slice(args.indexOf("-b"), args.indexOf("-b") + 2)).toEqual([
      "-b",
      "1024"
    ]);
    expect(args.slice(args.indexOf("-ub"), args.indexOf("-ub") + 2)).toEqual([
      "-ub",
      "1024"
    ]);
    expect(args.slice(args.indexOf("--image-min-tokens"), args.indexOf("--image-min-tokens") + 2)).toEqual([
      "--image-min-tokens",
      "1024"
    ]);
    expect(args.slice(args.indexOf("--image-max-tokens"), args.indexOf("--image-max-tokens") + 2)).toEqual([
      "--image-max-tokens",
      "1024"
    ]);
    expect(args.slice(args.indexOf("--temp"), args.indexOf("--temp") + 2)).toEqual(["--temp", "0.2"]);
    expect(args.slice(args.indexOf("--top-k"), args.indexOf("--top-k") + 2)).toEqual(["--top-k", "64"]);
    expect(args.slice(args.indexOf("--top-p"), args.indexOf("--top-p") + 2)).toEqual(["--top-p", "0.95"]);
    expect(args.slice(args.indexOf("--min-p"), args.indexOf("--min-p") + 2)).toEqual(["--min-p", "0.0"]);
  });

  it("passes economy performance tuning launch options when explicitly configured", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 1024,
      ctx: 8192,
      batch: 1024,
      ubatch: 1024,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      threadsBatch: 16,
      poll: 100,
      pollBatch: true,
      prioBatch: 2,
      cacheIdleSlots: false,
      cacheReuse: 128,
      enableMetrics: true,
      enablePerf: false,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE
    });

    expect(args.slice(args.indexOf("--threads-batch"), args.indexOf("--threads-batch") + 2)).toEqual([
      "--threads-batch",
      "16"
    ]);
    expect(args.slice(args.indexOf("--poll"), args.indexOf("--poll") + 2)).toEqual(["--poll", "100"]);
    expect(args.slice(args.indexOf("--poll-batch"), args.indexOf("--poll-batch") + 2)).toEqual(["--poll-batch", "1"]);
    expect(args.slice(args.indexOf("--prio-batch"), args.indexOf("--prio-batch") + 2)).toEqual(["--prio-batch", "2"]);
    expect(args).toContain("--no-cache-idle-slots");
    expect(args.slice(args.indexOf("--cache-reuse"), args.indexOf("--cache-reuse") + 2)).toEqual([
      "--cache-reuse",
      "128"
    ]);
    expect(args).toContain("--metrics");
    expect(args).toContain("--no-perf");
  });

  it("launches the 26B economy preset on mainline llama instead of beellama-only flags", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 2048,
      ctx: 8192,
      batch: 1024,
      ubatch: 1024,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      kvOffload: true,
      mmprojOffload: true,
      gpuLayers: "fit",
      enableMetrics: true,
      enablePerf: true,
      imageMinTokens: 1024,
      imageMaxTokens: 1024,
      modelRepo: DEFAULT_26B_REPO,
      modelFile: DEFAULT_26B_FILE,
      mmprojRepo: DEFAULT_26B_MMPROJ_REPO,
      mmprojFile: DEFAULT_26B_MMPROJ_FILE
    });

    expect(args).toContain("--fit");
    expect(args.slice(args.indexOf("--fit-target"), args.indexOf("--fit-target") + 2)).toEqual(["--fit-target", "2048"]);
    expect(args.slice(args.indexOf("-ngl"), args.indexOf("-ngl") + 2)).toEqual(["-ngl", "auto"]);
    expect(args).toContain("--no-cache-prompt");
    expect(args).toContain("--no-warmup");
    expect(args).toContain("--mmproj-offload");
    expect(args).not.toContain("--kv-unified");
    expect(args).not.toContain("--jinja");
    expect(args).not.toContain("--no-mmap");
    expect(args).not.toContain("--mlock");
    expect(args).not.toContain("--no-host");
  });

  it("passes the full VRAM smoke DFlash draft options to llama-server", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 2048,
      ubatch: 1536,
      cacheTypeK: "q4_0",
      cacheTypeV: "q4_0",
      ctxCheckpoints: 0,
      mmprojOffload: false,
      enableMetrics: true,
      enablePerf: true,
      useDraft: true,
      draftModelRepo: DEFAULT_DRAFT_REPO,
      draftModelFile: DEFAULT_DRAFT_FILE,
      imageMinTokens: 1024,
      imageMaxTokens: 1024,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE
    });

    expect(args).toContain("--no-mmproj-offload");
    expect(args).toContain("--metrics");
    expect(args).toContain("--perf");
    expect(args.slice(args.indexOf("-ngl"), args.indexOf("-ngl") + 2)).toEqual([
      "-ngl",
      "all"
    ]);
    expect(args.slice(args.indexOf("-b"), args.indexOf("-b") + 2)).toEqual([
      "-b",
      "2048"
    ]);
    expect(args.slice(args.indexOf("-ub"), args.indexOf("-ub") + 2)).toEqual([
      "-ub",
      "1536"
    ]);
    expect(args.slice(args.indexOf("-np"), args.indexOf("-np") + 2)).toEqual(["-np", "1"]);
    expect(args.slice(args.indexOf("--ctx-checkpoints"), args.indexOf("--ctx-checkpoints") + 2)).toEqual([
      "--ctx-checkpoints",
      "0"
    ]);
    const draftFlagIndex = args.findIndex((arg) => arg === "--spec-draft-hf" || arg === "--spec-draft-model");
    expect(draftFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[draftFlagIndex + 1]).toSatisfy((value: string) =>
      value === `${DEFAULT_DRAFT_REPO}:IQ4_XS` || value.endsWith(DEFAULT_DRAFT_FILE)
    );
    expect(args).toContain("--spec-type");
    expect(args).toContain("dflash");
    expect(args).toContain("--spec-dflash-cross-ctx");
    expect(args).toContain("--spec-draft-ngl");
    expect(args).toContain("all");
    expect(args).toContain("--spec-draft-n-max");
    expect(args).toContain("16");
    expect(args).toContain("--spec-branch-budget");
    expect(args).toContain("0");
    expect(args).toContain("--kv-unified");
    expect(args).toContain("--jinja");
    expect(args).toContain("--no-mmap");
    expect(args).toContain("--mlock");
    expect(args).toContain("--no-host");
    expect(args).not.toContain("--n-cpu-moe");
    expect(args).not.toContain("--chat-template-kwargs");
  });

  it("launches from app-managed HF cache files after direct download", () => {
    const hubCacheDir = createTempDir("hf-managed-cache-");
    const options = {
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 2048,
      ubatch: 1536,
      useDraft: true,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      draftModelRepo: DEFAULT_DRAFT_REPO,
      draftModelFile: DEFAULT_DRAFT_FILE,
      hfHubCacheDir: hubCacheDir
    };
    const modelPath = resolveManagedHfFilePath(options, DEFAULT_31B_REPO, DEFAULT_31B_FILE);
    const mmprojPath = resolveManagedHfFilePath(options, DEFAULT_MMPROJ_REPO, DEFAULT_MMPROJ_FILE);
    const draftPath = resolveManagedHfFilePath(options, DEFAULT_DRAFT_REPO, DEFAULT_DRAFT_FILE);
    for (const filePath of [modelPath, mmprojPath, draftPath]) {
      if (!filePath) {
        throw new Error("managed path not resolved");
      }
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, "cached");
    }

    const args = buildLaunchArgs(options);

    expect(args).toContain("-m");
    expect(args).toContain(modelPath);
    expect(args).toContain("--mmproj");
    expect(args).toContain(mmprojPath);
    expect(args).toContain("--spec-draft-model");
    expect(args).toContain(draftPath);
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(args).not.toContain("--mmproj-url");
    expect(args).not.toContain("--spec-draft-hf");
    expect(isModelCached(options)).toBe(true);
  });

  it("collects only the HF files needed by the selected VRAM mode", () => {
    const hubCacheDir = createTempDir("hf-download-plan-");
    const llamaCacheDir = createTempDir("llama-download-plan-");
    const baseOptions = {
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      draftModelRepo: DEFAULT_DRAFT_REPO,
      draftModelFile: DEFAULT_DRAFT_FILE,
      hfHubCacheDir: hubCacheDir,
      llamaCacheDir
    };

    expect(collectRequiredHfDownloads({ ...baseOptions, useDraft: false }).map((task) => task.kind)).toEqual([
      "model",
      "mmproj"
    ]);
    expect(collectRequiredHfDownloads({ ...baseOptions, useDraft: true }).map((task) => task.kind)).toEqual([
      "model",
      "mmproj",
      "draft"
    ]);
  });

  it("can explicitly offload the multimodal projector to GPU for diagnostics", () => {
    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 1024,
      ctx: 8192,
      batch: 512,
      ubatch: 512,
      mmprojOffload: true,
      modelRepo: DEFAULT_31B_REPO,
      modelFile: DEFAULT_31B_FILE,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE
    });

    expect(args).toContain("--mmproj-offload");
    expect(args).not.toContain("--no-mmproj-offload");
  });

  it("prefers sibling cached mmproj paths for custom cached HF models", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const modelFile = "custom-vision-model.gguf";
    const repoId = "custom/vision-model";
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-new",
      modelFile
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      hfHubCacheDir: hubCacheDir
    });

    expect(args).toContain("-m");
    expect(args).toContain(join(snapshotDir, modelFile));
    expect(args).toContain("--mmproj");
    expect(args).toContain(join(snapshotDir, "mmproj-BF16.gguf"));
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(isModelCached({ modelRepo: repoId, modelFile, hfHubCacheDir: hubCacheDir })).toBe(true);
  });

  it("uses a cached HF model with mmproj-url when the separate mmproj is not cached yet", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const llamaCacheDir = createTempDir("llama-cache-empty-");
    const modelFile = DEFAULT_31B_FILE;
    const repoId = DEFAULT_31B_REPO;
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-model-only",
      modelFile,
      includeMmproj: false
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      hfHubCacheDir: hubCacheDir,
      llamaCacheDir
    });

    expect(args).toContain("-m");
    expect(args).toContain(join(snapshotDir, modelFile));
    expect(args).toContain("--mmproj-url");
    expect(args).toContain(
      `https://huggingface.co/${DEFAULT_MMPROJ_REPO}/resolve/main/${encodeURIComponent(DEFAULT_MMPROJ_FILE)}`
    );
    expect(args).not.toContain("-hf");
    expect(args).not.toContain("-hff");
    expect(isModelCached({ modelRepo: repoId, modelFile, mmprojRepo: DEFAULT_MMPROJ_REPO, mmprojFile: DEFAULT_MMPROJ_FILE, hfHubCacheDir: hubCacheDir, llamaCacheDir })).toBe(false);
  });

  it("treats beellama's llama.cpp mmproj cache as already downloaded", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const llamaCacheDir = createTempDir("llama-cache-");
    const modelFile = DEFAULT_31B_FILE;
    const repoId = DEFAULT_31B_REPO;
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-model-only",
      modelFile,
      includeMmproj: false
    });
    const mmprojPath = join(llamaCacheDir, DEFAULT_MMPROJ_FILE);
    writeFileSync(mmprojPath, "mmproj");

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      hfHubCacheDir: hubCacheDir,
      llamaCacheDir
    });

    expect(args).toContain("-m");
    expect(args).toContain(join(snapshotDir, modelFile));
    expect(args).toContain("--mmproj");
    expect(args).toContain(mmprojPath);
    expect(args).not.toContain("--mmproj-url");
    expect(isModelCached({ modelRepo: repoId, modelFile, mmprojRepo: DEFAULT_MMPROJ_REPO, mmprojFile: DEFAULT_MMPROJ_FILE, hfHubCacheDir: hubCacheDir, llamaCacheDir })).toBe(true);
  });

  it("uses separate cached mmproj repo assets with cached HF model assets", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const modelFile = DEFAULT_31B_FILE;
    const repoId = DEFAULT_31B_REPO;
    const snapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-model",
      modelFile,
      includeMmproj: false
    });
    const mmprojSnapshotDir = writeCachedAssets({
      hubCacheDir,
      repoId: DEFAULT_MMPROJ_REPO,
      snapshot: "snapshot-mmproj",
      modelFile: DEFAULT_MMPROJ_FILE,
      includeMmproj: false
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      mmprojRepo: DEFAULT_MMPROJ_REPO,
      mmprojFile: DEFAULT_MMPROJ_FILE,
      hfHubCacheDir: hubCacheDir
    });

    expect(args).toContain("-m");
    expect(args).toContain(join(snapshotDir, modelFile));
    expect(args).toContain("--mmproj");
    expect(args).toContain(join(mmprojSnapshotDir, DEFAULT_MMPROJ_FILE));
    expect(args).not.toContain("--mmproj-url");
    expect(isModelCached({ modelRepo: repoId, modelFile, mmprojRepo: DEFAULT_MMPROJ_REPO, mmprojFile: DEFAULT_MMPROJ_FILE, hfHubCacheDir: hubCacheDir })).toBe(true);
  });

  it("keeps generic custom HF repo launch when a custom mmproj is not configured", () => {
    const hubCacheDir = createTempDir("hf-cache-");
    const modelFile = "custom-q4.gguf";
    const repoId = "custom/gemma-vision";
    writeCachedAssets({
      hubCacheDir,
      repoId,
      snapshot: "snapshot-partial",
      modelFile,
      includeMmproj: false
    });

    const args = buildLaunchArgs({
      port: 18180,
      fitTargetMb: 4096,
      ctx: 16384,
      batch: 32,
      ubatch: 32,
      modelRepo: repoId,
      modelFile,
      hfHubCacheDir: hubCacheDir
    });

    expect(args).toContain("-m");
    expect(args).not.toContain("--mmproj");
    expect(args).not.toContain("--mmproj-url");
    expect(isModelCached({ modelRepo: repoId, modelFile, hfHubCacheDir: hubCacheDir })).toBe(true);
  });

  it("detects cached assets from HF_HOME when HF_HUB_CACHE is unset", () => {
    const hfHomeDir = createTempDir("hf-home-");
    const previousHfHome = process.env.HF_HOME;
    const previousHubCache = process.env.HF_HUB_CACHE;
    const previousLegacyHubCache = process.env.HUGGINGFACE_HUB_CACHE;
    delete process.env.HF_HUB_CACHE;
    delete process.env.HUGGINGFACE_HUB_CACHE;
    process.env.HF_HOME = hfHomeDir;

    const modelFile = DEFAULT_31B_FILE;
    const repoId = DEFAULT_31B_REPO;
    writeCachedAssets({
      hubCacheDir: join(hfHomeDir, "hub"),
      repoId,
      snapshot: "snapshot-env",
      modelFile
    });

    try {
      expect(isModelCached({ modelRepo: repoId, modelFile })).toBe(true);
    } finally {
      if (previousHfHome === undefined) {
        delete process.env.HF_HOME;
      } else {
        process.env.HF_HOME = previousHfHome;
      }
      if (previousHubCache === undefined) {
        delete process.env.HF_HUB_CACHE;
      } else {
        process.env.HF_HUB_CACHE = previousHubCache;
      }
      if (previousLegacyHubCache === undefined) {
        delete process.env.HUGGINGFACE_HUB_CACHE;
      } else {
        process.env.HUGGINGFACE_HUB_CACHE = previousLegacyHubCache;
      }
    }
  });
});
