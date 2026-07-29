import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMIC_BUBBLE_DETECTOR_BYTES,
  COMIC_BUBBLE_DETECTOR_FILE,
  COMIC_BUBBLE_DETECTOR_SHA256,
  ONNXRUNTIME_WEB_VERSION,
  ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
  ONNXRUNTIME_WEB_WASM_BINARY_FILE,
  ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
  ONNXRUNTIME_WEB_WASM_BINARY_URL,
  ONNXRUNTIME_WEB_WASM_MODULE_FILE,
} from "../src/main/bubbleLayout/constants";

const onnxRuntimeMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  ensureRemoteFile: vi.fn(),
  wasmEnvironment: {} as Record<string, unknown>,
}));

vi.mock("../src/main/runtimeSupport/modelDownloads", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/main/runtimeSupport/modelDownloads")
    >();
  return {
    ...actual,
    ensureRemoteFile: onnxRuntimeMocks.ensureRemoteFile,
  };
});

vi.mock("onnxruntime-web", () => ({
  env: { wasm: onnxRuntimeMocks.wasmEnvironment },
  InferenceSession: { create: onnxRuntimeMocks.createSession },
}));

beforeEach(() => {
  vi.resetModules();
  onnxRuntimeMocks.ensureRemoteFile.mockReset();
  onnxRuntimeMocks.ensureRemoteFile.mockImplementation(
    async (options: { fileName: string; modelDir: string }) =>
      `${options.modelDir}/${options.fileName}`,
  );
  onnxRuntimeMocks.createSession.mockReset();
  onnxRuntimeMocks.createSession.mockResolvedValue({
    inputNames: ["images", "orig_target_sizes"],
    outputNames: ["labels", "boxes", "scores"],
  });
  for (const key of Object.keys(onnxRuntimeMocks.wasmEnvironment)) {
    delete onnxRuntimeMocks.wasmEnvironment[key];
  }
});

describe("comic bubble ONNX runtime", () => {
  it("downloads only the verified WASM binary beside the cached model", async () => {
    const dataRoot = resolve("test-data");
    const { ensureComicBubbleDetectorAssets } =
      await import("../src/main/bubbleLayout/assets");

    const assets = await ensureComicBubbleDetectorAssets({ dataRoot });

    expect(onnxRuntimeMocks.ensureRemoteFile).toHaveBeenCalledTimes(2);
    expect(onnxRuntimeMocks.ensureRemoteFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        modelDir: resolve(
          dataRoot,
          "models",
          "bubble-layout",
          "comic-text-and-bubble-detector",
        ),
        fileName: COMIC_BUBBLE_DETECTOR_FILE,
        expectedSha256: COMIC_BUBBLE_DETECTOR_SHA256,
        minimumBytes: COMIC_BUBBLE_DETECTOR_BYTES,
      }),
    );
    expect(onnxRuntimeMocks.ensureRemoteFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        modelDir: resolve(
          dataRoot,
          "runtime",
          "onnxruntime-web",
          ONNXRUNTIME_WEB_VERSION,
        ),
        url: ONNXRUNTIME_WEB_WASM_BINARY_URL,
        fileName: ONNXRUNTIME_WEB_WASM_BINARY_FILE,
        expectedSha256: ONNXRUNTIME_WEB_WASM_BINARY_SHA256,
        minimumBytes: ONNXRUNTIME_WEB_WASM_BINARY_BYTES,
      }),
    );
    expect(assets).toEqual({
      modelPath: `${resolve(
        dataRoot,
        "models",
        "bubble-layout",
        "comic-text-and-bubble-detector",
      )}/${COMIC_BUBBLE_DETECTOR_FILE}`,
      wasmBinaryPath: `${resolve(
        dataRoot,
        "runtime",
        "onnxruntime-web",
        ONNXRUNTIME_WEB_VERSION,
      )}/${ONNXRUNTIME_WEB_WASM_BINARY_FILE}`,
      wasmModulePath: require.resolve(
        `onnxruntime-web/${ONNXRUNTIME_WEB_WASM_MODULE_FILE}`,
      ),
    });
  });

  it("pins file URLs before creation and rejects runtime path changes", async () => {
    const { getComicBubbleDetectorSession } =
      await import("../src/main/bubbleLayout/session");
    const options = {
      modelPath: resolve("models", "detector.onnx"),
      wasmBinaryPath: resolve("runtime", "ort.wasm"),
      wasmModulePath: resolve("runtime", "ort.mjs"),
    };

    const first = await getComicBubbleDetectorSession(options);
    const second = await getComicBubbleDetectorSession(options);

    expect(second).toBe(first);
    expect(onnxRuntimeMocks.createSession).toHaveBeenCalledTimes(1);
    expect(onnxRuntimeMocks.createSession).toHaveBeenCalledWith(
      resolve(options.modelPath),
      {
        executionProviders: ["wasm"],
        executionMode: "sequential",
        graphOptimizationLevel: "all",
        freeDimensionOverrides: { N: 1 },
      },
    );
    expect(onnxRuntimeMocks.wasmEnvironment).toEqual({
      wasmPaths: {
        mjs: pathToFileURL(resolve(options.wasmModulePath)).href,
        wasm: pathToFileURL(resolve(options.wasmBinaryPath)).href,
      },
      numThreads: 1,
      proxy: false,
    });

    await expect(
      getComicBubbleDetectorSession({
        ...options,
        wasmBinaryPath: resolve("runtime", "other.wasm"),
      }),
    ).rejects.toThrow(/런타임 경로를 다시 설정할 수 없습니다/);
    expect(onnxRuntimeMocks.createSession).toHaveBeenCalledTimes(1);
  });
});
