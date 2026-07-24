import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPaths } from "../src/main/appPaths";
import type { InpaintingEngine } from "../src/main/inpainting/inpaintingEngine";
import {
  acquireInpaintingEngine,
  type InpaintingEngineLease,
  type InpaintingEnginePoolDependencies,
} from "../src/main/inpainting/inpaintingEnginePool";

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

  it("uses only Flux when Flux is selected", async () => {
    const fluxLease = makeLease("flux-klein");
    acquireFlux.mockResolvedValue(fluxLease);

    await expect(
      acquireInpaintingEngine(
        {
          appPaths,
          model: "flux-klein",
          fluxBackend: "metal-native",
        },
        dependencies,
      ),
    ).resolves.toBe(fluxLease);
    expect(acquireFlux).toHaveBeenCalledOnce();
    expect(acquireKoharu).not.toHaveBeenCalled();
    expect(disposeKoharu).toHaveBeenCalledWith("switch-to-flux");
  });

  it.each(["lama-manga", "aot-inpainting"] as const)(
    "uses only %s when it is selected",
    async (model) => {
      const koharuLease = makeLease(model);
      acquireKoharu.mockResolvedValue(koharuLease);

      await expect(
        acquireInpaintingEngine(
          {
            appPaths,
            model,
            koharuBackend: "metal-native",
          },
          dependencies,
        ),
      ).resolves.toBe(koharuLease);
      expect(acquireKoharu).toHaveBeenCalledWith(
        expect.objectContaining({ model }),
      );
      expect(acquireFlux).not.toHaveBeenCalled();
      expect(disposeFlux).toHaveBeenCalledWith("switch-to-koharu");
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
