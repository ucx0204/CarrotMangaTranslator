import { describe, it, expect } from "vitest";
import {
  resolveDefaultAppSettings,
  buildBaseTranslationOptions,
  RTX_50_OCR_GPU_CUDA_TAG,
  parseStoredAppSettings,
  DEFAULT_OCR_GPU_CUDA_TAG,
} from "../src/main/appSettings";
import { join } from "node:path";
import type { AppSettings } from "../src/shared/settingsTypes";
import {
  resolveStoredLlamaRocmTarget,
  resolveStoredOcrGpuCudaTag,
  resolveStoredOcrModeSettings,
} from "../src/main/settings/appSettingsStoredResolvers";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("app settings helpers: GPU and OCR hardware routing", () => {
  it("preserves stored OCR routing without a hardware rewrite policy", () => {
    const defaults = resolveDefaultAppSettings();

    expect(resolveStoredOcrModeSettings(null, defaults)).toEqual({
      device: defaults.ocr.device,
      gpuBackend: defaults.ocr.gpuBackend,
      qualityMode: defaults.ocr.qualityMode,
    });
    expect(
      resolveStoredOcrModeSettings(
        {
          device: "gpu",
          gpuBackend: "rocm-transformers",
          qualityMode: "full",
        },
        defaults,
      ),
    ).toEqual({
      device: "gpu",
      gpuBackend: "rocm-transformers",
      qualityMode: "full",
    });
  });

  it("uses explicit safe defaults when optional runtime defaults are absent", () => {
    const defaults = resolveDefaultAppSettings();
    const sparseDefaults = structuredClone(defaults);
    Reflect.deleteProperty(sparseDefaults.gemma, "llamaRocmTarget");
    Reflect.deleteProperty(sparseDefaults.ocr, "gpuBackend");
    Reflect.deleteProperty(sparseDefaults.ocr, "gpuCudaTag");

    expect(resolveStoredOcrModeSettings(null, sparseDefaults)).toEqual({
      device: defaults.ocr.device,
      gpuBackend: "cuda",
      qualityMode: defaults.ocr.qualityMode,
    });
    expect(resolveStoredOcrGpuCudaTag(null, sparseDefaults)).toBe(
      DEFAULT_OCR_GPU_CUDA_TAG,
    );
    expect(resolveStoredLlamaRocmTarget(null, sparseDefaults, "rocm")).toBe(
      undefined,
    );
  });

  it("defaults supported 4GB and 8GB NVIDIA GPUs to full OCR", () => {
    const fourGbDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 3050",
        memoryMb: 4096,
        rtxGeneration: 30,
        computeCapability: 8.6,
        vendor: "nvidia",
      },
    );
    const belowFloorDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GPU",
        memoryMb: 4095,
        rtxGeneration: 30,
        computeCapability: 8.6,
        vendor: "nvidia",
      },
    );

    expect(fourGbDefaults.modelProvider).toBe("openai-codex");
    expect(fourGbDefaults.ocr.device).toBe("gpu");
    expect(fourGbDefaults.ocr.qualityMode).toBe("full");
    expect(belowFloorDefaults.ocr.device).toBe("gpu");
    expect(belowFloorDefaults.ocr.qualityMode).toBe("economy");
  });

  it("routes RTX 50 series Gemma runtimes to CUDA 13 builds", () => {
    const rtx50EconomyDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 5070 Ti",
        memoryMb: 16303,
        rtxGeneration: 50,
        computeCapability: 12,
      },
    );
    const economyOptions = buildBaseTranslationOptions({
      jobId: "job-rtx50-economy",
      runDir: "C:/runs/job-rtx50-economy",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: rtx50EconomyDefaults,
      env: {},
    });

    expect(economyOptions.llamaRuntimeProfile).toBe("rtx50");
    expect(economyOptions.ocrGpuCudaTag).toBe(RTX_50_OCR_GPU_CUDA_TAG);
    expect(economyOptions.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b9553-cuda13.3", "llama-server.exe"),
    );

    const rtx50FullDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 5090",
        memoryMb: 32607,
        rtxGeneration: 50,
        computeCapability: 12,
      },
    );
    const fullOptions = buildBaseTranslationOptions({
      jobId: "job-rtx50-full",
      runDir: "C:/runs/job-rtx50-full",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: rtx50FullDefaults,
      env: {},
    });

    expect(fullOptions.llamaRuntimeProfile).toBe("rtx50");
    expect(fullOptions.serverPath).toBe(
      join(
        "C:/app-data",
        "tools",
        "beellama-v0.2.0-cuda13.1",
        "llama-server.exe",
      ),
    );
  });

  it("routes known AMD GPUs with the full DFlash preset to BeeLlama HIP", () => {
    const amdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon RX 7900 XTX",
        memoryMb: 24576,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      },
    );
    const options = buildBaseTranslationOptions({
      jobId: "job-amd-rocm",
      runDir: "C:/runs/job-amd-rocm",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: amdDefaults,
      env: {},
    });

    expect(amdDefaults.gemma.llamaRuntimeProfile).toBe("rocm");
    expect(amdDefaults.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(options.llamaRuntimeProfile).toBe("rocm");
    expect(options.llamaRocmTarget).toBe("gfx110X");
    expect(options.ocrPipeline).toBe("hayai");
    expect(options.ocrDevice).toBe("gpu");
    expect(options.ocrGpuBackend).toBe("rocm-transformers");
    expect(options.ocrBboxProvider).toBe("hayai-regions");
    expect(options.ocrBboxMode).toBeUndefined();
    expect(options.ocrEngine).toBeUndefined();
    expect(options.serverPath).toBe(
      join(
        "C:/app-data",
        "tools",
        "beellama-v0.3.1-hip-radeon",
        "llama-server.exe",
      ),
    );
  });

  it("routes Azure Radeon PRO V710 to the AMD ROCm Gemma profile", () => {
    const amdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon PRO V710",
        memoryMb: 28672,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        rocmArch: null,
        supportsVulkan: true,
        supportsRocm: false,
      },
    );

    expect(amdDefaults.modelProvider).toBe("gemma");
    expect(amdDefaults.gemma.llamaRuntimeProfile).toBe("rocm");
    expect(amdDefaults.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(amdDefaults.ocr.device).toBe("gpu");
    expect(amdDefaults.ocr.gpuBackend).toBe("rocm-transformers");
  });

  it("restores the AMD ROCm target when old saved settings only kept the ROCm profile", () => {
    const amdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon PRO V710 MxGPU",
        memoryMb: 28672,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: true,
      },
    );
    const restored = parseStoredAppSettings(
      JSON.stringify({
        modelProvider: "gemma",
        gemma: {
          llamaRuntimeProfile: "rocm",
          vramMode: "minimum12b",
        },
      }),
      amdDefaults,
    );
    const options = buildBaseTranslationOptions({
      jobId: "job-amd-v710-restored",
      runDir: "C:/runs/job-amd-v710-restored",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: restored,
      env: {},
    });

    expect(restored.gemma.llamaRuntimeProfile).toBe("rocm");
    expect(restored.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(options.llamaRocmTarget).toBe("gfx110X");
    expect(options.serverPath).toBe(
      join(
        "C:/app-data",
        "tools",
        "lemonade-llama-b1291-rocm-gfx110X",
        "llama-server.exe",
      ),
    );
  });

  it("keeps GPU OCR off for AMD GPUs Windows ROCm PyTorch does not support", () => {
    const rx7600mXtDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon RX 7600M XT",
        memoryMb: 8192,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: true,
      },
    );
    expect(rx7600mXtDefaults.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(rx7600mXtDefaults.gemma.llamaRuntimeProfile).toBe("rocm");
    expect(rx7600mXtDefaults.ocr.gpuBackend).not.toBe("rocm-transformers");
    expect(rx7600mXtDefaults.ocr.device).toBe("cpu");
    expect(rx7600mXtDefaults.inpainting?.model).toBe("lama-manga");
    expect(rx7600mXtDefaults.inpainting?.fluxBackend).toBe("cpu-native");

    const rx7600Defaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon RX 7600",
        memoryMb: 8192,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      },
    );
    // The llama target keeps working through its own runtimes...
    expect(rx7600Defaults.gemma.llamaRocmTarget).toBe("gfx110X");
    // ...but OCR must not default to the Windows ROCm PyTorch backend.
    expect(rx7600Defaults.ocr.gpuBackend).not.toBe("rocm-transformers");
    expect(rx7600Defaults.ocr.device).toBe("cpu");
    expect(rx7600Defaults.inpainting?.fluxBackend).toBe("zluda-native");

    const igpuDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon 780M",
        memoryMb: 16384,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      },
    );
    expect(igpuDefaults.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(igpuDefaults.ocr.gpuBackend).not.toBe("rocm-transformers");
    expect(igpuDefaults.ocr.device).toBe("cpu");

    const rx6800Defaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon RX 6800 XT",
        memoryMb: 16384,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      },
    );
    expect(rx6800Defaults.gemma.llamaRocmTarget).toBe("gfx103X");
    expect(rx6800Defaults.ocr.gpuBackend).not.toBe("rocm-transformers");
    expect(rx6800Defaults.ocr.device).toBe("cpu");
    expect(rx6800Defaults.inpainting?.model).toBe("lama-manga");
    expect(rx6800Defaults.inpainting?.fluxBackend).toBe("cpu-native");

    const rx6700Defaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon RX 6700 XT",
        memoryMb: 12288,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      },
    );
    expect(rx6700Defaults.inpainting?.model).toBe("lama-manga");
    expect(rx6700Defaults.inpainting?.fluxBackend).toBe("cpu-native");
  });

  it("preserves an explicitly stored OCR device and backend", () => {
    const igpuDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon 780M",
        memoryMb: 16384,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      },
    );
    const restored = parseStoredAppSettings(
      JSON.stringify({
        ocr: { device: "gpu", gpuBackend: "rocm-transformers" },
      }),
      igpuDefaults,
    );
    expect(restored.ocr).toMatchObject({
      gpuBackend: "rocm-transformers",
      device: "gpu",
      qualityMode: "economy",
    });

    const staleCudaRestored = parseStoredAppSettings(
      JSON.stringify({
        ocr: {
          device: "gpu",
          gpuBackend: "cuda",
          qualityMode: "full",
        },
      }),
      igpuDefaults,
    );
    expect(staleCudaRestored.ocr).toMatchObject({
      gpuBackend: "cuda",
      device: "gpu",
      qualityMode: "full",
    });

    const supportedDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon RX 7900 XTX",
        memoryMb: 24576,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      },
    );
    const supportedRestored = parseStoredAppSettings(
      JSON.stringify({
        ocr: { device: "gpu", gpuBackend: "rocm-transformers" },
      }),
      supportedDefaults,
    );
    expect(supportedRestored.ocr.gpuBackend).toBe("rocm-transformers");
    expect(supportedRestored.ocr.device).toBe("gpu");
  });

  it("never rewrites an explicitly selected runtime OCR device or backend", () => {
    const unsupportedAmd = {
      ...resolveDefaultAppSettings(
        {},
        {
          name: "AMD Radeon RX 6700 XT",
          memoryMb: 12288,
          rtxGeneration: null,
          computeCapability: null,
          vendor: "amd" as const,
          rocmArch: "gfx1031",
          supportsVulkan: true,
          supportsRocm: false,
        },
      ),
      ocr: {
        device: "gpu" as const,
        gpuBackend: "rocm-transformers" as const,
        qualityMode: "full" as const,
        gpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      },
      runtimeHardware: {
        gpuVendor: "amd" as const,
        gpuName: "AMD Radeon RX 6700 XT",
        supportsOcrRocm: false,
      },
    };
    const optionInput = {
      jobId: "job-rx6700-stale",
      runDir: "C:/runs/job-rx6700-stale",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: unsupportedAmd,
    };

    const selected = buildBaseTranslationOptions({ ...optionInput, env: {} });
    expect(selected).toMatchObject({
      ocrDevice: "gpu",
      ocrGpuBackend: "rocm-transformers",
      ocrQualityMode: "full",
    });

    for (const env of [
      { MANGA_TRANSLATOR_OCR_DEVICE: "gpu" },
      { MANGA_TRANSLATOR_OCR_GPU_BACKEND: "rocm-transformers" },
      {
        MANGA_TRANSLATOR_OCR_DEVICE: "gpu",
        MANGA_TRANSLATOR_OCR_GPU_BACKEND: "rocm-transformers",
      },
    ]) {
      const explicitPowerUser = buildBaseTranslationOptions({
        ...optionInput,
        env,
      });
      expect(explicitPowerUser).toMatchObject({
        ocrDevice: "gpu",
        ocrGpuBackend: "rocm-transformers",
        ocrQualityMode: "full",
      });
    }

    const invalidOverride = buildBaseTranslationOptions({
      ...optionInput,
      env: {
        MANGA_TRANSLATOR_OCR_DEVICE: "definitely-not-a-device",
        MANGA_TRANSLATOR_OCR_GPU_BACKEND: "not-a-backend",
      },
    });
    expect(invalidOverride).toMatchObject({
      ocrDevice: "gpu",
      ocrGpuBackend: "rocm-transformers",
      ocrQualityMode: "full",
    });
  });

  it("preserves Hayai on unsupported hardware instead of silently selecting Paddle", () => {
    const defaults = resolveDefaultAppSettings();
    const paths = {
      dataRoot: "C:/app-data",
      toolsDir: "C:/tools",
      llamaServerPath: "C:/tools/llama-server.exe",
      hfHomeDir: "C:/hf-home",
      hfHubCacheDir: "C:/hf-home/hub",
    };

    for (const gpuVendor of ["apple", "unknown"] as const) {
      const settings: AppSettings = {
        ...defaults,
        ocr: {
          ...defaults.ocr,
          pipeline: "hayai",
          device: "gpu",
          gpuBackend: "cuda",
          qualityMode: "full",
        },
        runtimeHardware: { gpuVendor },
      };
      const options = buildBaseTranslationOptions({
        jobId: `job-${gpuVendor}-stale-hayai`,
        runDir: `C:/runs/${gpuVendor}-stale-hayai`,
        paths,
        settings,
        env: {},
      });

      expect(options).toMatchObject({
        ocrPipeline: "hayai",
        ocrDevice: "gpu",
        ocrGpuBackend: "cuda",
        ocrBboxProvider: "hayai-regions",
      });
    }
  });

  it("never pairs GPU-only full OCR qualities with the CPU device", () => {
    const nvidiaDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
      },
    );
    // Stored cpu+full combos are normalized down to economy quality.
    const restored = parseStoredAppSettings(
      JSON.stringify({ ocr: { device: "cpu", qualityMode: "full" } }),
      nvidiaDefaults,
    );
    expect(restored.ocr.device).toBe("cpu");
    expect(restored.ocr.qualityMode).toBe("economy");
    const restoredLegacy = parseStoredAppSettings(
      JSON.stringify({
        ocr: { device: "cpu", qualityMode: "cuda-legacy-full" },
      }),
      nvidiaDefaults,
    );
    expect(restoredLegacy.ocr.device).toBe("cpu");
    expect(restoredLegacy.ocr.qualityMode).toBe("economy");
    // GPU keeps the full quality.
    expect(nvidiaDefaults.ocr.device).toBe("gpu");
    expect(nvidiaDefaults.ocr.qualityMode).toBe("full");

    // Hardware defaults: a 32GB AMD card without Windows ROCm OCR support
    // gets CPU OCR, so the full31b tier must not select GPU-only full quality.
    const w6800Defaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon PRO W6800",
        memoryMb: 32768,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      },
    );
    expect(w6800Defaults.gemma.vramMode).toBe("full31b");
    expect(w6800Defaults.ocr.device).toBe("cpu");
    expect(w6800Defaults.ocr.qualityMode).toBe("economy");

    const amdLegacyRestored = parseStoredAppSettings(
      JSON.stringify({
        ocr: {
          device: "gpu",
          gpuBackend: "rocm-transformers",
          qualityMode: "cuda-legacy-full",
        },
      }),
      resolveDefaultAppSettings(
        {},
        {
          name: "AMD Radeon RX 7900 XTX",
          memoryMb: 24576,
          rtxGeneration: null,
          computeCapability: null,
          vendor: "amd",
          supportsRocm: true,
        },
      ),
    );
    expect(amdLegacyRestored.ocr.qualityMode).toBe("full");
  });

  it("keeps saved OCR modes independent from detected NVIDIA and AMD hardware", () => {
    const amdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon RX 7900 XTX",
        memoryMb: 24576,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsRocm: true,
      },
    );
    const amdRestored = parseStoredAppSettings(
      JSON.stringify({
        ocr: {
          device: "gpu",
          gpuBackend: "cuda",
          qualityMode: "cuda-legacy-full",
        },
      }),
      amdDefaults,
    );
    expect(amdRestored.ocr.gpuBackend).toBe("cuda");
    expect(amdRestored.ocr.qualityMode).toBe("full");

    const nvidiaDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
      },
    );
    const nvidiaRestored = parseStoredAppSettings(
      JSON.stringify({
        ocr: {
          device: "gpu",
          gpuBackend: "rocm-transformers",
          qualityMode: "full",
        },
      }),
      nvidiaDefaults,
    );
    expect(nvidiaRestored.ocr.gpuBackend).toBe("rocm-transformers");
    expect(nvidiaRestored.ocr.qualityMode).toBe("full");

    const unsupportedAmdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon RX 6800 XT",
        memoryMb: 16384,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      },
    );
    const unsupportedAmdRestored = parseStoredAppSettings(
      JSON.stringify({
        ocr: {
          device: "gpu",
          gpuBackend: "cuda",
          qualityMode: "cuda-legacy-full",
        },
      }),
      unsupportedAmdDefaults,
    );
    expect(unsupportedAmdRestored.ocr.gpuBackend).toBe("cuda");
    expect(unsupportedAmdRestored.ocr.device).toBe("gpu");
    expect(unsupportedAmdRestored.ocr.qualityMode).toBe("full");
  });

  it("runs economy OCR when the runtime resolves full quality onto the CPU", () => {
    const nvidiaDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
      },
    );
    const settings: AppSettings = {
      ...nvidiaDefaults,
      ocr: {
        ...nvidiaDefaults.ocr,
        pipeline: "paddle-legacy",
        device: "cpu",
        qualityMode: "full",
      },
    };
    const options = buildBaseTranslationOptions({
      jobId: "job-cpu-full-cap",
      runDir: "C:/runs/job-cpu-full-cap",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings,
      env: {},
    });

    expect(options.ocrDevice).toBe("cpu");
    expect(options.ocrBboxMode).toBe("ocr");
    expect(options.ocrEngine).toBe("paddle_static");
    expect(options.ocrTextDetectionModelName).toBe("PP-OCRv6_small_det");
    expect(options.ocrTextRecognitionModelName).toBe("PP-OCRv6_small_rec");
  });

  it("coerces saved runtime backends that do not match the detected GPU vendor", () => {
    const amdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon PRO V710",
        memoryMb: 28672,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: true,
      },
    );
    const nvidiaDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
      },
    );

    const amdNormalized = parseStoredAppSettings(
      JSON.stringify({
        gemma: {
          llamaRuntimeProfile: "cuda12",
        },
        ocr: {
          device: "gpu",
        },
        inpainting: {
          fluxBackend: "cuda-native",
        },
      }),
      amdDefaults,
    );
    const nvidiaNormalized = parseStoredAppSettings(
      JSON.stringify({
        gemma: {
          llamaRuntimeProfile: "rocm",
          llamaRocmTarget: "gfx110X",
        },
        inpainting: {
          fluxBackend: "python-rocm",
        },
      }),
      nvidiaDefaults,
    );

    expect(amdNormalized.gemma.llamaRuntimeProfile).toBe("rocm");
    expect(amdNormalized.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(amdNormalized.ocr.device).toBe("gpu");
    expect(amdNormalized.inpainting?.fluxBackend).toBe(
      amdDefaults.inpainting?.fluxBackend,
    );
    expect(nvidiaNormalized.gemma.llamaRuntimeProfile).toBe("cuda12");
    expect(nvidiaNormalized.inpainting?.fluxBackend).toBe("cuda-native");
  });

  it("locks SM75 and newer NVIDIA GPUs to their compatible Flux CUDA backend", () => {
    const sm75Defaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 2070 SUPER",
        memoryMb: 8192,
        rtxGeneration: 20,
        computeCapability: 7.5,
        vendor: "nvidia",
      },
    );
    const modernNvidiaDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24576,
        rtxGeneration: 40,
        computeCapability: 8.9,
        vendor: "nvidia",
      },
    );
    const amdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon RX 7900 XTX",
        memoryMb: 24576,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsRocm: true,
        supportsVulkan: true,
      },
    );
    const experimentalRaw = JSON.stringify({
      inpainting: { fluxBackend: "cuda-sm75-experimental" },
    });
    const standardRaw = JSON.stringify({
      inpainting: { fluxBackend: "cuda-native" },
    });

    expect(sm75Defaults.inpainting?.fluxBackend).toBe("cuda-sm75-experimental");
    expect(sm75Defaults.ocr.device).toBe("gpu");
    expect(sm75Defaults.ocr.qualityMode).toBe("full");
    expect(
      parseStoredAppSettings(standardRaw, sm75Defaults).inpainting?.fluxBackend,
    ).toBe("cuda-sm75-experimental");
    expect(
      parseStoredAppSettings(experimentalRaw, modernNvidiaDefaults).inpainting
        ?.fluxBackend,
    ).toBe("cuda-native");
    expect(
      parseStoredAppSettings(experimentalRaw, amdDefaults).inpainting
        ?.fluxBackend,
    ).toBe(amdDefaults.inpainting?.fluxBackend);
  });

  it("does not replace an explicitly selected OCR GPU with CPU", () => {
    const defaults = resolveDefaultAppSettings();
    const settings: AppSettings = {
      ...defaults,
      modelProvider: "gemma",
      gemma: {
        ...defaults.gemma,
        llamaRuntimeProfile: "rocm",
      },
      ocr: {
        ...defaults.ocr,
        device: "gpu",
        gpuBackend: "cuda",
        gpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      },
    };

    const options = buildBaseTranslationOptions({
      jobId: "job-amd-ocr-cpu",
      runDir: "C:/runs/job-amd-ocr-cpu",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings,
      env: {},
    });

    expect(options.llamaRuntimeProfile).toBe("rocm");
    expect(options.ocrDevice).toBe("gpu");
    expect(options.ocrGpuBackend).toBe("cuda");
  });

  it("allows OCR GPU for AMD llama runtimes with the ROCm Transformers backend", () => {
    const defaults = resolveDefaultAppSettings();
    const settings: AppSettings = {
      ...defaults,
      modelProvider: "gemma",
      gemma: {
        ...defaults.gemma,
        llamaRuntimeProfile: "rocm",
      },
      ocr: {
        ...defaults.ocr,
        device: "gpu",
        gpuBackend: "rocm-transformers",
        gpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      },
    };

    const options = buildBaseTranslationOptions({
      jobId: "job-amd-ocr-rocm",
      runDir: "C:/runs/job-amd-ocr-rocm",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings,
      env: {},
    });

    expect(options.llamaRuntimeProfile).toBe("rocm");
    expect(options.ocrDevice).toBe("gpu");
    expect(options.ocrGpuBackend).toBe("rocm-transformers");
  });

  it("keeps Paddle OCR CUDA tag separate from the llama runtime profile", () => {
    const defaults = resolveDefaultAppSettings();
    const paths = {
      dataRoot: "C:/app-data",
      toolsDir: "C:/tools",
      llamaServerPath: "C:/tools/llama-server.exe",
      hfHomeDir: "C:/hf-home",
      hfHubCacheDir: "C:/hf-home/hub",
    };
    const settings: AppSettings = {
      ...defaults,
      modelProvider: "gemma",
      gemma: {
        ...defaults.gemma,
        llamaRuntimeProfile: "cuda12",
      },
      ocr: {
        ...defaults.ocr,
        device: "gpu",
        gpuCudaTag: RTX_50_OCR_GPU_CUDA_TAG,
      },
    };

    const cuda12Options = buildBaseTranslationOptions({
      jobId: "job-ocr-cu129-llama-cuda12",
      runDir: "C:/runs/job-ocr-cu129-llama-cuda12",
      paths,
      settings,
      env: {},
    });
    const rtx50Options = buildBaseTranslationOptions({
      jobId: "job-ocr-cu129-llama-rtx50",
      runDir: "C:/runs/job-ocr-cu129-llama-rtx50",
      paths,
      settings,
      env: {
        MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE: "rtx50",
      },
    });

    expect(cuda12Options.ocrGpuCudaTag).toBe(RTX_50_OCR_GPU_CUDA_TAG);
    expect(cuda12Options.llamaRuntimeProfile).toBe("cuda12");
    expect(cuda12Options.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b9553-cuda12.4", "llama-server.exe"),
    );
    expect(rtx50Options.ocrGpuCudaTag).toBe(RTX_50_OCR_GPU_CUDA_TAG);
    expect(rtx50Options.llamaRuntimeProfile).toBe("rtx50");
    expect(rtx50Options.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b9553-cuda13.3", "llama-server.exe"),
    );
  });

  it("canonicalizes llama runtime profile aliases before settings can be saved", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        '{"gemma":{"llamaRuntimeProfile":"cuda13.1"}}',
        defaults,
      ).gemma.llamaRuntimeProfile,
    ).toBe("rtx50");
    expect(
      parseStoredAppSettings(
        '{"gemma":{"llamaRuntimeProfile":"blackwell"}}',
        defaults,
      ).gemma.llamaRuntimeProfile,
    ).toBe("rtx50");

    const options = buildBaseTranslationOptions({
      jobId: "job-rtx50-alias",
      runDir: "C:/runs/job-rtx50-alias",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: defaults,
      env: {
        MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE: "cuda13.1",
      },
    });

    expect(options.llamaRuntimeProfile).toBe("rtx50");
  });
});
