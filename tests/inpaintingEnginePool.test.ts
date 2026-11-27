import { withModelWorkload } from "../src/main/runtimeSupport/modelWorkload";
import { release } from "node:os";
import {
  acquireQwenInpaintingEngine,
  disposeCachedQwenInpaintingEngine,
} from "../src/main/inpainting/qwenImageEngine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import {
  acquireInpaintingEngine,
  type InpaintingEngineLease,
  type InpaintingEnginePoolDependencies,
} from "../src/main/inpainting/inpaintingEnginePool";

vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, release: vi.fn(os.release) };
});

const acquireFlux = vi.fn<InpaintingEnginePoolDependencies["acquireFlux"]>();
const acquireKoharu =
  vi.fn<InpaintingEnginePoolDependencies["acquireKoharu"]>();
const disposeFlux = vi.fn<InpaintingEnginePoolDependencies["disposeFlux"]>();
const disposeKoharu =
  vi.fn<InpaintingEnginePoolDependencies["disposeKoharu"]>();
const dependencies: InpaintingEnginePoolDependencies = {
  acquireFlux,
  acquireKoharu,
  disposeFlux,
  disposeKoharu,
  totalMemoryBytes: () => 32 * 1024 * 1024 * 1024,
};
const appPaths = makeAppPaths();

describe("selected inpainting model routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disposeFlux.mockResolvedValue(false);
    disposeKoharu.mockResolvedValue(false);
  });

  it.each(["flux-klein", "lama-manga", "aot-inpainting"] as const)(
    "retains one native %s lease across sequential children and disposes once at group exit",
    async (model) => {
      const native = makeLease(model);
      const acquire = model === "flux-klein" ? acquireFlux : acquireKoharu;
      const dispose = model === "flux-klein" ? disposeFlux : disposeKoharu;
      acquire.mockResolvedValue(native);
      await withModelWorkload(
        "inpainting",
        new AbortController().signal,
        async () => {
          for (let page = 0; page < 3; page++) {
            const child = await acquireInpaintingEngine(
              { appPaths, model },
              dependencies,
            );
            expect(child.engine).toBe(native.engine);
            await child.release();
            expect(native.release).not.toHaveBeenCalled();
            expect(dispose).not.toHaveBeenCalled();
          }
        },
      );
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(native.release).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledWith("workload-complete");
    },
  );

  it("releases both idle models before acquiring the selected Qwen adapter", async () => {
    const native = makeLease("qwen-image-2.1");
    const qwen = {
      acquire: vi.fn(async () => ({
        engine: native.engine,
        release: async () => {
          await native.release();
        },
      })),
      dispose: vi.fn(async () => true),
    };
    const signal = new AbortController().signal;
    const lease = await acquireInpaintingEngine(
      {
        appPaths,
        model: "qwen-image-2.1",
        fluxBackend: "vulkan-native",
        computeGpuIndex: 1,
        signal,
      },
      { ...dependencies, qwen },
    );
    expect(qwen.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        fluxBackend: "vulkan-native",
        computeGpuIndex: 1,
      }),
    );
    expect(disposeFlux).toHaveBeenCalledWith("switch-to-qwen");
    expect(disposeKoharu).toHaveBeenCalledWith("switch-to-qwen");
    expect(qwen.acquire.mock.invocationCallOrder[0]).toBeGreaterThan(
      disposeFlux.mock.invocationCallOrder[0],
    );
    expect(lease.engine).toBe(native.engine);
    await lease.release();
    expect(native.release).toHaveBeenCalledTimes(1);
    expect(qwen.dispose).toHaveBeenCalledWith("workload-complete");
  });
  it("rejects unsupported devices and pre-cancelled jobs before loading model files", async () => {
    try {
      vi.stubGlobal("process", { ...process, platform: "linux", arch: "x64" });
      await expect(acquireQwenInpaintingEngine({ appPaths })).rejects.toThrow(
        "Windows x64",
      );
      vi.stubGlobal("process", {
        ...process,
        platform: "darwin",
        arch: "arm64",
      });
      vi.mocked(release).mockReturnValueOnce("24.6.0");
      await expect(acquireQwenInpaintingEngine({ appPaths })).rejects.toThrow(
        "macOS 26",
      );
      await expect(
        acquireQwenInpaintingEngine({
          appPaths,
          signal: AbortSignal.abort(),
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await disposeCachedQwenInpaintingEngine("unused")).toBe(false);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
  it("uses only Flux when Flux is selected", async () => {
    const fluxLease = makeLease("flux-klein");
    acquireFlux.mockResolvedValue(fluxLease);
    const lease = await acquireInpaintingEngine(
      {
        appPaths,
        model: "flux-klein",
        fluxBackend: "metal-native",
        computeGpuIndex: 3,
      },
      dependencies,
    );
    expect(lease.engine).toBe(fluxLease.engine);
    expect(acquireFlux).toHaveBeenCalledOnce();
    expect(acquireFlux).toHaveBeenCalledWith(
      expect.objectContaining({ computeGpuIndex: 3 }),
    );
    expect(acquireKoharu).not.toHaveBeenCalled();
    expect(disposeKoharu).toHaveBeenCalledWith("switch-to-flux");
    expect(disposeFlux).not.toHaveBeenCalled();
    await lease.release();
    expect(fluxLease.release).toHaveBeenCalledOnce();
    expect(disposeFlux).toHaveBeenCalledWith("workload-complete");
  });

  it.each(["lama-manga", "aot-inpainting"] as const)(
    "uses only %s when it is selected",
    async (model) => {
      const koharuLease = makeLease(model);
      acquireKoharu.mockResolvedValue(koharuLease);
      const lease = await acquireInpaintingEngine(
        { appPaths, model, koharuBackend: "metal-native", computeGpuIndex: 4 },
        dependencies,
      );
      expect(lease.engine).toBe(koharuLease.engine);
      expect(acquireKoharu).toHaveBeenCalledWith(
        expect.objectContaining({ model, computeGpuIndex: 4 }),
      );
      expect(acquireFlux).not.toHaveBeenCalled();
      expect(disposeFlux).toHaveBeenCalledWith("switch-to-koharu");
      expect(disposeKoharu).not.toHaveBeenCalled();
      await lease.release();
      expect(koharuLease.release).toHaveBeenCalledOnce();
      expect(disposeKoharu).toHaveBeenCalledWith("workload-complete");
    },
  );
});

function makeLease(model: InpaintingEngine["model"]): InpaintingEngineLease {
  return {
    engine: {
      backend: "test",
      dispose: vi.fn().mockResolvedValue(undefined),
      inpaint: vi.fn().mockResolvedValue(undefined),
      model,
      runRootDir: "C:/test/run",
      runtimePath: "C:/test/runtime",
    },
    release: vi.fn(),
  };
}

function makeAppPaths(): AppPaths {
  return {
    dataRoot: "C:/test/data",
    executableDir: "C:/test",
    fontsDir: "C:/test/data/fonts",
    isPackaged: false,
    libraryDir: "C:/test/library",
    llamaRuntimeDir: "C:/test/llama",
    llamaServerPath: "C:/test/llama/server",
    logFile: "C:/test/logs/app.log",
    logsDir: "C:/test/logs",
    ocrRuntimeDir: "C:/test/ocr",
    repoRoot: "C:/test",
    resourcesDir: "C:/test/resources",
    runtimeDir: "C:/test/runtime",
    settingsPath: "C:/test/settings.json",
    toolsDir: "C:/test/tools",
  };
}
