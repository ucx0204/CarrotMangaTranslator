import { buildRuntimeCapabilities } from "../src/main/runtimeCapabilities";
import { qwenNativeDevice } from "../src/main/inpainting/qwenPlatformGpu";
import { describe, expect, it, vi } from "vitest";
import {
  getDefaultAppSettings,
  normalizeAppSettingsForRuntime,
} from "../src/main/settingsStore";
import {
  parseIntelVulkanDevices,
  queryIntelVulkanGpu,
} from "../src/main/windowsIntelVulkan";
import { parseWindowsIntelGpuLine } from "../src/main/windowsAmdGpuInfo";
import { resolveHunyuanExecution } from "../src/shared/hunyuanOcr";
import { resolveKoharuBackendCandidates } from "../src/main/inpainting/koharuEnginePool";
import { resolveHardwareRecommendation } from "../src/renderer/src/components/settingsModal/hardwareRecommendation";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

function requireDetectedGpu<T>(gpu: T | null): T {
  if (gpu === null) throw new Error("Invalid GPU fixture");
  return gpu;
}
const iris = requireDetectedGpu(
  parseWindowsIntelGpuLine(
    [
      "Intel(R) Iris(R) Xe Graphics",
      "Intel Corporation",
      "Display",
      "PCI\\VEN_8086&DEV_9A49",
      "2147483648",
      "video",
      "0",
      "true",
    ].join("\x1f"),
  ),
);
const arc = requireDetectedGpu(
  parseIntelVulkanDevices(
    "8086\t0\tIntel Iris Xe\n10DE\t24576\tNVIDIA\n8086\t16384\tIntel(R) Arc(TM) A770 Graphics",
  ),
);

describe("Intel model routing", () => {
  it("installs a hash-locked Hayai XPU runtime and probes the requested XPU index", () => {
    const options = {
      ocrPipeline: "hayai",
      ocrDevice: "gpu",
      ocrGpuBackend: "xpu",
      computeGpuIndex: 2,
    };
    const {
      resolveOcrRuntimeVariant,
    } = require("../src/main/runtime/ocr/runtime-device.cjs");
    const {
      resolveIntegrityPinnedOcrInstallBatches,
    } = require("../src/main/runtime/ocr/requirements-integrity.cjs");
    const {
      buildOcrRuntimeImportCheckScript,
    } = require("../src/main/runtime/ocr/runtime-import-check-script.cjs");
    const {
      applyOcrComputeGpuVisibility,
    } = require("../src/main/runtime/compute-gpu-selection.cjs");
    expect(resolveOcrRuntimeVariant(options)).toBe("hayai-xpu");
    if (process.platform === "win32") {
      const [batch] = resolveIntegrityPinnedOcrInstallBatches([], options);
      expect(batch).toContain("--require-hashes");
      expect(batch.at(-1)).toMatch(/requirements-hayai-xpu-win\.lock$/);
    }
    expect(resolveOcrRuntimeVariant({ ...options, ocrDevice: "cpu" })).toBe(
      "hayai-cpu",
    );
    expect(buildOcrRuntimeImportCheckScript(options)).toContain(
      "torch.xpu.synchronize(index)",
    );
    const {
      buildOcrRuntimeDllSearchDirs,
    } = require("../src/main/runtime/ocr/runtime-path-environment.cjs");
    const root = process.cwd();
    const paths = buildOcrRuntimeDllSearchDirs(
      { ...options, toolsDir: root },
      { packageDir: root },
      root,
    ).map((p: string) => p.replaceAll("\\", "/"));
    expect(paths).toContain(root.replaceAll("\\", "/") + "/Library/bin");
    const env = {};
    applyOcrComputeGpuVisibility(env, {}, options);
    expect(env).toEqual({});
    applyOcrComputeGpuVisibility(env, options, options);
    expect(env).toEqual({ MGT_HAYAI_XPU_INDEX: "2" });
    expect(() =>
      resolveOcrRuntimeVariant({ ...options, ocrPipeline: "paddle-legacy" }),
    ).toThrow(/HayaiOCR/);
  });
  it("uses the detected Arc for Qwen on a dual-Intel PC while honoring an explicit integrated GPU index", () => {
    const devices = "Vulkan0\tIntel Iris Xe\nVulkan1\tIntel Arc A770";
    expect(
      qwenNativeDevice(devices, "vulkan", undefined, "Intel Arc A770").key,
    ).toBe("Vulkan1");
    expect(qwenNativeDevice(devices, "vulkan", 0, "Intel Arc A770").key).toBe(
      "Vulkan0",
    );
  });
  it("requires an enumerated GPU when the Gemma Vulkan library loads", () => {
    const {
      llamaRuntimeProbeLooksGpuBacked,
    } = require("../src/main/runtime/model/server-preflight.cjs");
    expect(
      llamaRuntimeProbeLooksGpuBacked(
        "loaded Vulkan backend\nggml_vulkan: Found 0 Vulkan devices\nCPU: AMD Ryzen",
        "vulkan",
      ),
    ).toBe(false);
    expect(
      llamaRuntimeProbeLooksGpuBacked(
        "Available devices:\n  Vulkan0: Intel Iris Xe (2048 MiB)",
        "vulkan",
      ),
    ).toBe(true);
  });
  it("launches CPU Gemma with the CPU package and disables GPU offload", () => {
    const {
      resolvePreferredLlamaRuntime,
    } = require("../src/main/runtime/model/runtime-profile.cjs");
    const {
      buildLaunchArgs,
    } = require("../src/main/runtime/model/launch-arguments.cjs");
    const options = {
      llamaRuntimeProfile: "cpu",
      modelSource: "huggingface",
      gpuLayers: "all",
      mmprojOffload: true,
      computeGpuIndex: 3,
    };
    expect(resolvePreferredLlamaRuntime(options).backend).toBe("cpu");
    const args: string[] = buildLaunchArgs(options);
    expect(args[args.indexOf("-ngl") + 1]).toBe("0");
    expect(args).toContain("--no-mmproj-offload");
    expect(args).not.toContain("--main-gpu");
  });
  it("falls back to CPU after a driver probe failure and uses only Intel Vulkan output on success", async () => {
    execFile.mockImplementationOnce((_exe, _args, _options, done) =>
      done(new Error("driver timed out"), ""),
    );
    await expect(queryIntelVulkanGpu()).resolves.toBeNull();
    execFile.mockImplementationOnce((_exe, _args, _options, done) =>
      done(null, "10DE\t24576\tNVIDIA\n8086\t8192\tIntel Arc"),
    );
    await expect(queryIntelVulkanGpu()).resolves.toMatchObject({
      name: "Intel Arc",
      memoryMb: 8192,
    });
    expect(execFile).toHaveBeenCalledWith(
      "powershell.exe",
      expect.any(Array),
      { windowsHide: true, timeout: 6000 },
      expect.any(Function),
    );
  });
  it("uses a physical display's PCI vendor and a separate Vulkan capability probe", () => {
    expect(iris).toMatchObject({
      vendor: "intel",
      supportsVulkan: false,
      memoryMb: null,
    });
    expect(arc).toMatchObject({
      vendor: "intel",
      supportsVulkan: true,
      memoryMb: 16384,
    });
    expect(
      parseIntelVulkanDevices("10DE\t16384\tNVIDIA\n8086\tn/a\tIntel"),
    ).toBeNull();
    expect(
      parseIntelVulkanDevices("8086\t0\tIntel Iris Xe")?.memoryMb,
    ).toBeNull();
    expect(
      parseWindowsIntelGpuLine(
        [
          "Intel",
          "Intel",
          "Display",
          "PCI\\VEN_10DE&DEV_1234",
          "",
          "pnp",
          "0",
          "true",
        ].join("\x1f"),
      ),
    ).toBeNull();
    expect(
      parseWindowsIntelGpuLine(
        [
          "Intel",
          "Intel",
          "Display",
          "PCI\\VEN_8086&DEV_1234",
          "",
          "pnp",
          "22",
          "false",
        ].join("\x1f"),
      ),
    ).toBeNull();
  });
  it.each([iris, { ...iris, supportsVulkan: true }, arc])(
    "keeps UI recommendations and model defaults in agreement for $name / $supportsVulkan",
    async (gpu) => {
      const settings = await getDefaultAppSettings({}, async () => gpu);
      const recommendation = resolveHardwareRecommendation({
        intel: { vulkan: !!gpu.supportsVulkan, hayaiXpu: gpu === arc },
        usesAmdHardware: false,
        usesNvidiaHardware: false,
        usesAppleHardware: false,
        unifiedMemoryMb: null,
        gpuMemoryMb: gpu.memoryMb,
      });
      expect(settings.runtimeHardware?.gpuVendor).toBe("intel");
      expect(
        buildRuntimeCapabilities({ platform: "win32", arch: "x64", gpu }).ocr
          .gpu,
      ).toBe(Boolean(gpu.supportsVulkan));
      expect(settings.inpainting).toMatchObject({
        model: recommendation.inpaintingModel,
        fluxBackend: recommendation.fluxBackend,
        fluxMode: recommendation.fluxMode,
      });
      expect(settings.gemma.llamaRuntimeProfile).toBe(
        gpu.supportsVulkan ? "vulkan" : "cpu",
      );
      expect(settings.ocr.device).toBe("cpu");
      expect(
        await resolveKoharuBackendCandidates("auto", async () => gpu, "win32"),
      ).toEqual(["cpu"]);
      const execution = resolveHunyuanExecution(
        { model: "f16", device: "auto" },
        settings.runtimeHardware,
        32768,
        "win32",
      );
      expect(execution.backend).toBe(gpu === arc ? "vulkan" : "cpu");
      const manual = resolveHunyuanExecution(
        { model: "q4", device: "gpu" },
        settings.runtimeHardware,
        32768,
        "win32",
      );
      expect(manual.backend).toBe(gpu.supportsVulkan ? "vulkan" : "cpu");
    },
  );
  it.skipIf(process.platform === "darwin")(
    "repairs saved CUDA and ROCm routes when an Intel PC upgrades or imports settings",
    async () => {
      const detect = async () => arc;
      const settings = await getDefaultAppSettings({}, detect);
      settings.gemma.llamaRuntimeProfile = "rocm";
      settings.gemma.llamaRocmTarget = "gfx110X";
      if (!settings.inpainting) throw new Error("Missing inpainting defaults");
      settings.inpainting = {
        ...settings.inpainting,
        fluxBackend: "rocm-native",
        koharuBackend: "cuda-native",
      };
      settings.ocr = {
        ...settings.ocr,
        pipeline: "hayai",
        device: "gpu",
        gpuBackend: "rocm-transformers",
      };
      const migrated = await normalizeAppSettingsForRuntime(
        settings,
        {},
        detect,
      );
      expect(migrated.gemma.llamaRuntimeProfile).toBe("vulkan");
      expect(migrated.gemma.llamaRocmTarget).toBeUndefined();
      expect(migrated.inpainting).toMatchObject({
        fluxBackend: "vulkan-native",
        koharuBackend: "auto",
      });
      expect(migrated.ocr.device).toBe("cpu");
      settings.ocr.gpuBackend = "xpu";
      expect(
        (await normalizeAppSettingsForRuntime(settings, {}, detect)).ocr.device,
      ).toBe("gpu");
      settings.ocr.pipeline = "paddle-legacy";
      expect(
        (await normalizeAppSettingsForRuntime(settings, {}, detect)).ocr.device,
      ).toBe("cpu");
      settings.gemma.llamaRuntimeProfile = "cpu";
      settings.inpainting.fluxBackend = "cpu-native";
      const manual = await normalizeAppSettingsForRuntime(settings, {}, detect);
      expect(manual.gemma.llamaRuntimeProfile).toBe("cpu");
      expect(manual.inpainting?.fluxBackend).toBe("cpu-native");
    },
  );
});
