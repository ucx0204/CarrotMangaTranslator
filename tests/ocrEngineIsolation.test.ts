import { describe, expect, it } from "vitest";
import {
  resolveOcrBboxProvider as resolveSharedOcrBboxProvider,
  resolveOcrEngineDisplayName,
} from "../src/shared/ocrEngines";

const runtime =
  require("../src/main/runtime/simple-page-ocr-runtime-config.cjs") as {
    buildOcrRuntimeEnv: (
      options: Record<string, unknown>,
      runtime?: Record<string, unknown>,
    ) => Record<string, string | undefined>;
    buildOcrRuntimeImportCheckScript: (
      options: Record<string, unknown>,
    ) => string;
    buildOcrRuntimeImportFailureMessage: (
      error: unknown,
      options: Record<string, unknown>,
    ) => string;
    buildOcrGpuFailureMessage: (
      error: unknown,
      options: Record<string, unknown>,
    ) => string;
    resolveOcrPipInstallBatches: (
      options: Record<string, unknown>,
    ) => string[][];
    resolveOcrPythonPackageDir: (
      runtimeDir: string,
      options: Record<string, unknown>,
    ) => string;
    resolveOcrRuntimeDir: (options: Record<string, unknown>) => string;
    resolveOcrRuntimeVariant: (options: Record<string, unknown>) => string;
    resolveOcrBboxProviderForRequest: (
      options: Record<string, unknown>,
      requestedProvider?: unknown,
    ) => string;
    resolveOcrEngineLabel: (options: Record<string, unknown>) => string;
    resolvePaddleOcrGpuPackageIndexUrl: (
      options: Record<string, unknown>,
    ) => string;
    resolveOcrVenvDir: (
      runtimeDir: string,
      variant: string,
      options: Record<string, unknown>,
    ) => string;
  };
const bboxPipeline =
  require("../src/main/runtime/simple-page-ocr-bbox-pipeline.cjs") as {
    collectOcrBboxHintsBatch: (
      pageOptionsList: Record<string, unknown>[],
    ) => Promise<unknown[]>;
    resolveOcrBboxProvider: (options: Record<string, unknown>) => string;
  };
const progressHandlers =
  require("../src/main/runtime/simple-page-ocr-progress-handlers.cjs") as {
    createOcrCommandProgressHandler: (
      options: Record<string, unknown>,
      config: Record<string, unknown>,
    ) => (line: string) => void;
  };
const commands =
  require("../src/main/runtime/simple-page-ocr-commands.cjs") as {
    buildOcrBboxBatchCommand: (
      options: Record<string, unknown>,
      batchPath: string,
      runtime: { pythonPath: string },
    ) => { args: string[] };
  };
const runtimePreparation =
  require("../src/main/runtime/ocr/runtime-preparation.cjs") as {
    isManagedOcrPackagePathLine: (
      line: string,
      pythonDir: string,
      runtimeDir: string,
    ) => boolean;
    preparePaddlexCacheHome: (
      options: Record<string, unknown>,
      runtimeDir: string,
    ) => Promise<unknown>;
  };
const paddleModelAssets =
  require("../src/main/runtime/simple-page-model-assets.cjs") as {
    ensurePaddleOcrModelAssetsDownloaded: (
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    repairPaddleOcrModelAssetsCache: (
      options: Record<string, unknown>,
    ) => Promise<unknown>;
  };
const commandRunnerFactory =
  require("../src/main/runtime/ocr/bbox-command-runner.cjs") as {
    createOcrCommandRunner: (dependencies: Record<string, unknown>) => {
      runOcrCommandWithModelRepair: (
        command: { executable: string; args: string[] },
        options: Record<string, unknown>,
        runtime?: Record<string, unknown> | null,
        runOptions?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  };

const HAYAI_ROUTES = [
  [{ ocrPipeline: "hayai", ocrDevice: "cpu" }, "hayai-cpu"],
  [
    {
      ocrPipeline: "hayai",
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
      ocrGpuCudaTag: "cu126",
    },
    "hayai-cuda-cu126",
  ],
  [
    {
      ocrPipeline: "hayai",
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
      ocrGpuCudaTag: "cu129",
    },
    "hayai-cuda-cu130",
  ],
  [
    {
      ocrPipeline: "hayai",
      ocrDevice: "gpu",
      ocrGpuBackend: "rocm-transformers",
    },
    "hayai-rocm",
  ],
] as const;

describe("OCR engine runtime isolation", () => {
  it.each(["hayai", "paddle-legacy"] as const)(
    "keeps the shared UI and managed runtime profile identical for %s",
    (ocrPipeline) => {
      expect(runtime.resolveOcrEngineLabel({ ocrPipeline })).toBe(
        resolveOcrEngineDisplayName(ocrPipeline),
      );
      expect(runtime.resolveOcrBboxProviderForRequest({ ocrPipeline })).toBe(
        resolveSharedOcrBboxProvider(ocrPipeline),
      );
    },
  );

  it("derives the managed provider and executable from the selected pipeline", () => {
    const hayaiOptions = {
      ocrPipeline: "hayai",
      ocrDevice: "cpu",
      ocrBboxProvider: "paddleocr",
    };
    const legacyOptions = {
      ocrPipeline: "paddle-legacy",
      ocrDevice: "cpu",
      ocrBboxProvider: "hayai-regions",
    };

    expect(runtime.resolveOcrBboxProviderForRequest(hayaiOptions)).toBe(
      "hayai-regions",
    );
    expect(bboxPipeline.resolveOcrBboxProvider(hayaiOptions)).toBe(
      "hayai-regions",
    );
    expect(
      commands
        .buildOcrBboxBatchCommand(hayaiOptions, "batch.json", {
          pythonPath: "python.exe",
        })
        .args.join(" "),
    ).toContain("hayai-bboxes.py");

    expect(runtime.resolveOcrBboxProviderForRequest(legacyOptions)).toBe(
      "paddleocr",
    );
    expect(bboxPipeline.resolveOcrBboxProvider(legacyOptions)).toBe(
      "paddleocr",
    );
    expect(
      commands
        .buildOcrBboxBatchCommand(legacyOptions, "batch.json", {
          pythonPath: "python.exe",
        })
        .args.join(" "),
    ).toContain("paddleocr-bboxes.py");
  });

  it("preserves non-engine delivery providers without allowing engine crossing", () => {
    expect(
      runtime.resolveOcrBboxProviderForRequest(
        { ocrPipeline: "hayai" },
        "json-file",
      ),
    ).toBe("json-file");
    expect(
      runtime.resolveOcrBboxProviderForRequest(
        { ocrPipeline: "paddle-legacy" },
        "external-command",
      ),
    ).toBe("external-command");
  });

  it("rejects delivery-only providers at the managed batch command boundary", () => {
    expect(() =>
      commands.buildOcrBboxBatchCommand(
        {
          ocrPipeline: "hayai",
          ocrBboxProvider: "json-file",
        },
        "batch.json",
        { pythonPath: "python.exe" },
      ),
    ).toThrow(/requires a managed provider/i);
  });

  it("makes Paddle-only package policy inaccessible to HayaiOCR", () => {
    expect(() =>
      runtime.resolvePaddleOcrGpuPackageIndexUrl({
        ocrPipeline: "hayai",
        ocrDevice: "gpu",
      }),
    ).toThrow(/unavailable for the HayaiOCR pipeline/i);
  });

  it("fails closed if HayaiOCR reaches a Paddle-only cache boundary", async () => {
    const options = { ocrPipeline: "hayai" };
    await expect(
      runtimePreparation.preparePaddlexCacheHome(
        options,
        "C:/mgt-ocr-isolation",
      ),
    ).rejects.toThrow(/PaddleX cache preparation.*unavailable/i);
    await expect(
      paddleModelAssets.ensurePaddleOcrModelAssetsDownloaded(options),
    ).rejects.toThrow(/Paddle OCR model download.*unavailable/i);
    await expect(
      paddleModelAssets.repairPaddleOcrModelAssetsCache(options),
    ).rejects.toThrow(/Paddle OCR model repair.*unavailable/i);
  });

  it("never enters Paddle model-cache repair after a HayaiOCR failure", async () => {
    let repairs = 0;
    let attempts = 0;
    const runner = commandRunnerFactory.createOcrCommandRunner({
      buildOcrRuntimeEnv: () => ({}),
      emitRuntimeProgress: () => undefined,
      isHayaiOcrPipeline: (options: Record<string, unknown>) =>
        options.ocrPipeline === "hayai",
      isPaddleOcrModelAssetLoadFailure: () => true,
      repairPaddleOcrModelAssetsCache: async () => {
        repairs += 1;
      },
      runCommand: async () => {
        attempts += 1;
        throw new Error("simulated model load failure");
      },
    });

    await expect(
      runner.runOcrCommandWithModelRepair(
        { executable: "python", args: [] },
        { ocrPipeline: "hayai" },
      ),
    ).rejects.toThrow("simulated model load failure");
    expect(attempts).toBe(1);
    expect(repairs).toBe(0);
  });

  it("keeps Paddle model-cache repair inside the legacy runner", async () => {
    const progress: Array<Record<string, unknown>> = [];
    let repairs = 0;
    let attempts = 0;
    const runner = commandRunnerFactory.createOcrCommandRunner({
      buildOcrRuntimeEnv: () => ({}),
      emitRuntimeProgress: (
        _options: Record<string, unknown>,
        phase: string,
        progressText: string,
      ) => progress.push({ phase, progressText }),
      isHayaiOcrPipeline: () => false,
      isPaddleOcrModelAssetLoadFailure: () => true,
      repairPaddleOcrModelAssetsCache: async () => {
        repairs += 1;
      },
      runCommand: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("broken legacy model cache");
        return { stdout: "ok", stderr: "" };
      },
    });

    await expect(
      runner.runOcrCommandWithModelRepair(
        { executable: "python", args: [] },
        { ocrPipeline: "paddle-legacy" },
      ),
    ).resolves.toEqual({ stdout: "ok", stderr: "" });
    expect({ attempts, repairs }).toEqual({ attempts: 2, repairs: 1 });
    expect(progress).toContainEqual({
      phase: "ocr_downloading",
      progressText: "Paddle OCR 모델 캐시 복구 중",
    });
  });

  it("rejects a mixed-engine batch before one runtime can own every page", async () => {
    await expect(
      bboxPipeline.collectOcrBboxHintsBatch([
        {
          ocrPipeline: "hayai",
          ocrDevice: "cpu",
          ocrBboxProvider: "hayai-regions",
        },
        {
          ocrPipeline: "paddle-legacy",
          ocrDevice: "cpu",
          ocrBboxProvider: "paddleocr",
        },
      ]),
    ).rejects.toThrow(/different execution profile/i);
  });

  it("keeps generic model-fetch progress branded as HayaiOCR", () => {
    const events: Record<string, unknown>[] = [];
    const handleLine = progressHandlers.createOcrCommandProgressHandler(
      {
        ocrPipeline: "hayai",
        onProgress: (event: Record<string, unknown>) => events.push(event),
      },
      {
        engineLabel: "HayaiOCR",
        progressText: "HayaiOCR 모델 다운로드/위치 분석 중",
      },
    );

    handleLine("Fetching 19 files: 11%|█ | 2/19 [00:00<00:07, 2.14it/s]");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      ocrPipeline: "hayai",
      progressText: "HayaiOCR 모델 다운로드/위치 분석 중",
      detail: "HayaiOCR 모델 파일 다운로드 중: 2 / 19개 (11%)",
    });
    expect(JSON.stringify(events)).not.toMatch(/Paddle/i);
  });

  it.each(HAYAI_ROUTES)(
    "routes HayaiOCR through its dedicated %s runtime",
    (options, expectedVariant) => {
      expect(runtime.resolveOcrRuntimeVariant(options)).toBe(expectedVariant);

      const packagePlan = runtime.resolveOcrPipInstallBatches(options);
      expect(packagePlan.flat().join(" ")).not.toMatch(/paddle/i);

      const importCheck = runtime.buildOcrRuntimeImportCheckScript(options);
      expect(importCheck).not.toMatch(/paddle/i);
      expect(importCheck).toContain("AutoModel");
      expect(importCheck).toContain("AutoProcessor");
      expect(importCheck).toContain("PreTrainedTokenizerFast");
      expect(importCheck).toContain("snapshot_download");
      expect(importCheck).toContain("from PIL import Image");
    },
  );

  it.each(HAYAI_ROUTES)(
    "keeps HayaiOCR identity in runtime failures for %s",
    (options) => {
      const importFailure = runtime.buildOcrRuntimeImportFailureMessage(
        "DLL load failed while importing _C: sm_120",
        options,
      );
      expect(importFailure).toContain("HayaiOCR");
      expect(importFailure).not.toMatch(/Paddle/i);

      if (options.ocrDevice === "gpu") {
        const executionFailure = runtime.buildOcrGpuFailureMessage(
          new Error("DLL load failed while importing _C: sm_120"),
          options,
        );
        expect(executionFailure).toContain("HayaiOCR");
        expect(executionFailure).not.toMatch(/Paddle/i);
      }
    },
  );

  it.each(HAYAI_ROUTES)(
    "does not inject Paddle environment or DLL paths into %s",
    (options) => {
      const runtimeDir = runtime.resolveOcrRuntimeDir({
        ...options,
        ocrRuntimeDir: "C:/mgt-ocr-isolation",
      });
      const packageDir = runtime.resolveOcrPythonPackageDir(
        runtimeDir,
        options,
      );
      const env = runtime.buildOcrRuntimeEnv(options, {
        runtimeDir,
        packageDir,
        includePackageDir: true,
      });

      expect(Object.keys(env).filter((key) => /paddle/i.test(key))).toEqual([]);
      expect(env.MANGA_TRANSLATOR_OCR_DLL_DIRS).not.toMatch(/paddle/i);
    },
  );

  it("keeps HayaiOCR and legacy PaddleOCR package and venv roots disjoint", () => {
    const routePairs = [
      [{ ocrDevice: "cpu" }, { ocrPipeline: "hayai", ocrDevice: "cpu" }],
      [
        {
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
          ocrGpuCudaTag: "cu126",
        },
        {
          ocrPipeline: "hayai",
          ocrDevice: "gpu",
          ocrGpuBackend: "cuda",
          ocrGpuCudaTag: "cu126",
        },
      ],
      [
        { ocrDevice: "gpu", ocrGpuBackend: "rocm-transformers" },
        {
          ocrPipeline: "hayai",
          ocrDevice: "gpu",
          ocrGpuBackend: "rocm-transformers",
        },
      ],
    ] as const;

    for (const [legacy, hayai] of routePairs) {
      const legacyRoot = runtime.resolveOcrRuntimeDir({
        ...legacy,
        ocrRuntimeDir: "C:/mgt-ocr-isolation",
      });
      const hayaiRoot = runtime.resolveOcrRuntimeDir({
        ...hayai,
        ocrRuntimeDir: "C:/mgt-ocr-isolation",
      });
      const legacyVariant = runtime.resolveOcrRuntimeVariant(legacy);
      const hayaiVariant = runtime.resolveOcrRuntimeVariant(hayai);

      expect(hayaiVariant).not.toBe(legacyVariant);
      expect(runtime.resolveOcrPythonPackageDir(hayaiRoot, hayai)).not.toBe(
        runtime.resolveOcrPythonPackageDir(legacyRoot, legacy),
      );
      expect(
        runtime.resolveOcrVenvDir(hayaiRoot, hayaiVariant, hayai),
      ).not.toBe(runtime.resolveOcrVenvDir(legacyRoot, legacyVariant, legacy));
    }
  });

  it("recognizes both short ROCm package roots as managed runtime paths", () => {
    const pythonDir = "C:/tools/python";
    expect(
      runtimePreparation.isManagedOcrPackagePathLine(
        "C:/MGTOCR/h721/h",
        pythonDir,
        "C:/MGTOCR/h721",
      ),
    ).toBe(true);
    expect(
      runtimePreparation.isManagedOcrPackagePathLine(
        "C:/MGTOCR/r721/p",
        pythonDir,
        "C:/MGTOCR/r721",
      ),
    ).toBe(true);
    expect(
      runtimePreparation.isManagedOcrPackagePathLine(
        "C:/unrelated/h",
        pythonDir,
        "C:/MGTOCR/h721",
      ),
    ).toBe(false);
  });

  it("ignores legacy Paddle runtime overrides when HayaiOCR is selected", () => {
    const legacyOverrides = {
      MANGA_TRANSLATOR_OCR_PIP_PACKAGES: "paddle-global==9.9",
      MANGA_TRANSLATOR_OCR_CPU_TRANSFORMERS_PIP_PACKAGES: "paddle-cpu==9.9",
      MANGA_TRANSLATOR_OCR_CUDA_TRANSFORMERS_PIP_PACKAGES: "paddle-cuda==9.9",
      MANGA_TRANSLATOR_OCR_AMD_PIP_PACKAGES: "paddle-rocm==9.9",
      MANGA_TRANSLATOR_PADDLEOCR_DEVICE: "cpu",
      MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG: "cu999",
      MANGA_TRANSLATOR_PADDLEOCR_WORKER_THREADS: "99",
      MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN: "0",
    } as const;
    const previous = new Map(
      Object.keys(legacyOverrides).map((key) => [key, process.env[key]]),
    );

    try {
      Object.assign(process.env, legacyOverrides);
      for (const [options, expectedVariant] of HAYAI_ROUTES) {
        expect(runtime.resolveOcrRuntimeVariant(options)).toBe(expectedVariant);
        expect(
          runtime.resolveOcrPipInstallBatches(options).flat().join(" "),
        ).not.toMatch(/paddle/i);
        const env = runtime.buildOcrRuntimeEnv(options);
        expect(env.MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN).toBeUndefined();
        if (expectedVariant === "hayai-rocm") {
          expect(env.MANGA_TRANSLATOR_OCR_DISABLE_MIOPEN).toBe("1");
        }
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
