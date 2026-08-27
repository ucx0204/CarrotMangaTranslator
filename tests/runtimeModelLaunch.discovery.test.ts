import { describe, it, expect } from "vitest";
import {
  runtimeDefaults,
  DEFAULT_31B_REPO,
  DEFAULT_31B_FILE,
  DEFAULT_MMPROJ_REPO,
  DEFAULT_MMPROJ_FILE,
  createTempDir,
  resolveBundledServerPath,
  bundledServerCandidates,
  parsePipRawProgress,
  parseOcrBatchProgressLine,
  parsePaddleModelFetchProgress,
  resolveOcrBboxTimeoutMs,
  collectRequiredPaddleOcrModelDownloads,
  collectRequiredHfDownloads,
  DEFAULT_26B_REPO,
  DEFAULT_26B_FILE,
  DEFAULT_26B_MMPROJ_REPO,
  DEFAULT_26B_MMPROJ_FILE,
  buildOcrRuntimeEnv,
  restoreEnv,
  resolveLlamaCppCacheDir,
  buildLlamaServerEnv,
} from "./helpers/runtimeModelContracts";
import { join, delimiter } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows(
  "runtime model support helpers: runtime discovery and downloads",
  () => {
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
      const runtimeDir = join(toolsDir, "llama-b9553-cuda12.4");
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
          "Creating model: ('PP-OCRv6_medium_det', None, None)",
        ),
      ).toBeNull();
    });

    it("allows slow first-run Paddle model downloads before timing out OCR bbox analysis", () => {
      const previous = process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS;
      delete process.env.MANGA_TRANSLATOR_OCR_BBOX_TIMEOUT_MS;
      try {
        expect(resolveOcrBboxTimeoutMs(1)).toBeGreaterThanOrEqual(
          60 * 60 * 1000,
        );
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

      expect(tasks).toHaveLength(10);
      expect(tasks).toEqual(
        expect.arrayContaining([
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

    it("does not predownload native Paddle models for AMD ROCm Transformers OCR", () => {
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
        expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
        expect(env.PYTHONPYCACHEPREFIX).toBe(join(runtimeDir, "pycache"));
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
  },
);
