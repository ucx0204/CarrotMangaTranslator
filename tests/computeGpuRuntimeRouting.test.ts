import { describe, expect, it } from "vitest";
import {
  buildBaseTranslationOptions,
  resolveDefaultAppSettings,
} from "../src/main/appSettings";
import { buildFluxWorkerEnv } from "../src/main/inpainting/fluxWorkerEnv";
import { buildKoharuWorkerEnv } from "../src/main/inpainting/koharuWorker";
import { applyComputeGpuVisibilityEnv } from "../src/main/inpainting/computeGpuEnv";
import { detectNvidiaComputeCapability } from "../src/main/inpainting/fluxEnginePool";

const { buildLaunchArgs } =
  require("../src/main/runtime/simple-page-launch-args.cjs") as {
    buildLaunchArgs: (options: Record<string, unknown>) => string[];
  };
const { buildOcrBboxBatchCommand } =
  require("../src/main/runtime/simple-page-ocr-commands.cjs") as {
    buildOcrBboxBatchCommand: (
      options: Record<string, unknown>,
      batchPath: string,
      runtime: { pythonPath: string },
    ) => string;
  };
const { buildOcrRuntimeEnv } =
  require("../src/main/runtime/simple-page-ocr-runtime-config.cjs") as {
    buildOcrRuntimeEnv: (
      options: Record<string, unknown>,
    ) => Record<string, string>;
  };
const {
  applyComputeGpuVisibilityEnv: applyRuntimeComputeGpuVisibilityEnv,
  resolveComputeGpuIndex: resolveRuntimeComputeGpuIndex,
} = require("../src/main/runtime/compute-gpu-selection.cjs") as {
  applyComputeGpuVisibilityEnv: (
    env: NodeJS.ProcessEnv,
    index: number,
    backend: "cuda" | "rocm",
    platform: NodeJS.Platform,
  ) => NodeJS.ProcessEnv;
  resolveComputeGpuIndex: (value: unknown) => number | null;
};

describe("compute GPU runtime routing", () => {
  it("rejects malformed boolean GPU indices in the JS runtime boundary", () => {
    expect(resolveRuntimeComputeGpuIndex(false)).toBeNull();
    expect(resolveRuntimeComputeGpuIndex(true)).toBeNull();
  });

  it("copies an explicit settings GPU index into translation runtime options", () => {
    const settings = resolveDefaultAppSettings({});
    settings.hardware = {
      ...settings.hardware,
      computeGpuIndex: 2,
    };

    const options = buildBaseTranslationOptions({
      jobId: "gpu-routing",
      runDir: "C:/mgt/run",
      paths: {
        dataRoot: "C:/mgt/data",
        toolsDir: "C:/mgt/tools",
        llamaServerPath: "C:/mgt/llama-server.exe",
      },
      settings,
      env: {},
    });

    expect(options.computeGpuIndex).toBe(2);

    settings.hardware = { graphicsGpuPreference: "auto" };
    expect(
      buildBaseTranslationOptions({
        jobId: "gpu-auto",
        runDir: "C:/mgt/run",
        paths: {
          dataRoot: "C:/mgt/data",
          toolsDir: "C:/mgt/tools",
          llamaServerPath: "C:/mgt/llama-server.exe",
        },
        settings,
        env: {},
      }).computeGpuIndex,
    ).toBeUndefined();
  });

  it("pins llama-server to one main GPU only when explicitly configured", () => {
    const explicitArgs = buildLaunchArgs({
      ...makeLlamaLaunchOptions(),
      computeGpuIndex: 3,
    });
    const splitModeIndex = explicitArgs.indexOf("--split-mode");
    const mainGpuIndex = explicitArgs.indexOf("--main-gpu");

    expect(explicitArgs.slice(splitModeIndex, splitModeIndex + 2)).toEqual([
      "--split-mode",
      "none",
    ]);
    expect(explicitArgs.slice(mainGpuIndex, mainGpuIndex + 2)).toEqual([
      "--main-gpu",
      "3",
    ]);

    const automaticArgs = buildLaunchArgs(makeLlamaLaunchOptions());
    expect(automaticArgs).not.toContain("--split-mode");
    expect(automaticArgs).not.toContain("--main-gpu");

    const metalArgs = buildLaunchArgs({
      ...makeLlamaLaunchOptions(),
      computeGpuIndex: 1,
      llamaRuntimeProfile: "metal",
    });
    expect(metalArgs).not.toContain("--split-mode");
    expect(metalArgs).not.toContain("--main-gpu");
  });

  it("maps an explicitly selected OCR GPU to logical gpu:0", () => {
    const options = {
      computeGpuIndex: 4,
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
    };
    const env = buildOcrRuntimeEnv(options);
    const command = buildOcrBboxBatchCommand(options, "batch.json", {
      pythonPath: "python.exe",
    });

    expect(env).toMatchObject({
      CUDA_VISIBLE_DEVICES: "4",
    });
    expect(env.HIP_VISIBLE_DEVICES).toBeUndefined();
    expect(env.ROCR_VISIBLE_DEVICES).toBeUndefined();
    expect(env.GPU_DEVICE_ORDINAL).toBeUndefined();
    expect(command).toContain("gpu:0");

    const cpuEnv = buildOcrRuntimeEnv({
      ...options,
      ocrDevice: "cpu",
    });
    expect(cpuEnv.CUDA_VISIBLE_DEVICES).toBeUndefined();
    expect(cpuEnv.HIP_VISIBLE_DEVICES).toBeUndefined();
    expect(cpuEnv.ROCR_VISIBLE_DEVICES).toBeUndefined();
    expect(cpuEnv.GPU_DEVICE_ORDINAL).toBeUndefined();
  });

  it("applies the selected physical GPU to Flux and Koharu workers", () => {
    const fluxEnv = buildFluxWorkerEnv({
      backend: "cuda-native",
      computeGpuIndex: 5,
      executable: process.execPath,
      args: [],
      runtimePath: process.execPath,
      label: "Flux test",
    });
    const koharuEnv = buildKoharuWorkerEnv({
      backend: "cuda-native",
      computeGpuIndex: 6,
      executable: process.execPath,
      args: [],
      runtimePath: process.execPath,
      label: "Koharu test",
    });

    expect(fluxEnv).toMatchObject({
      CUDA_VISIBLE_DEVICES: "5",
    });
    expect(koharuEnv).toMatchObject({
      CUDA_VISIBLE_DEVICES: "6",
    });
  });

  it("uses one platform-appropriate ROCm isolation variable", () => {
    const windowsEnv: NodeJS.ProcessEnv = makeConflictingGpuEnv();
    applyComputeGpuVisibilityEnv(windowsEnv, 2, "python-rocm", "win32");
    expect(windowsEnv).toEqual({
      HIP_VISIBLE_DEVICES: "2",
      KEEP_ME: "yes",
    });

    const linuxEnv: NodeJS.ProcessEnv = makeConflictingGpuEnv();
    applyComputeGpuVisibilityEnv(linuxEnv, 3, "python-rocm", "linux");
    expect(linuxEnv).toEqual({
      ROCR_VISIBLE_DEVICES: "3",
      KEEP_ME: "yes",
    });

    const ocrRuntimeEnv: NodeJS.ProcessEnv = makeConflictingGpuEnv();
    applyRuntimeComputeGpuVisibilityEnv(ocrRuntimeEnv, 4, "rocm", "win32");
    expect(ocrRuntimeEnv).toEqual({
      HIP_VISIBLE_DEVICES: "4",
      KEEP_ME: "yes",
    });
  });

  it("queries the selected NVIDIA GPU when choosing a Flux runner", async () => {
    const queried: number[] = [];
    const capability = await detectNvidiaComputeCapability(1, async (index) => {
      queried.push(index);
      return "8.6\r\n";
    });

    expect(queried).toEqual([1]);
    expect(capability).toBe(8.6);
  });
});

function makeLlamaLaunchOptions(): Record<string, unknown> {
  return {
    port: 18180,
    fitTargetMb: 4096,
    ctx: 8192,
    batch: 512,
    ubatch: 512,
    modelSource: "huggingface",
    modelRepo: "test-owner/test-model",
    modelFile: "test-model.gguf",
  };
}

function makeConflictingGpuEnv(): NodeJS.ProcessEnv {
  return {
    CUDA_VISIBLE_DEVICES: "9",
    HIP_VISIBLE_DEVICES: "9",
    ROCR_VISIBLE_DEVICES: "9",
    GPU_DEVICE_ORDINAL: "9",
    KEEP_ME: "yes",
  };
}
