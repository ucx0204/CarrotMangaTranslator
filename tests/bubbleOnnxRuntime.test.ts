import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KOHARU_LAYOUT_ONNX_BYTES,
  KOHARU_LAYOUT_ONNX_FILE,
  KOHARU_LAYOUT_ONNX_SHA256,
} from "../src/main/bubbleLayout/constants";

const runtimeMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  ensureRemoteFile: vi.fn(),
}));

vi.mock("../src/main/runtimeSupport/modelDownloads", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/main/runtimeSupport/modelDownloads")
    >();
  return { ...actual, ensureRemoteFile: runtimeMocks.ensureRemoteFile };
});

vi.mock("../src/main/bubbleLayout/nativeOrt", () => ({
  onnxRuntimeNode: {
    InferenceSession: { create: runtimeMocks.createSession },
  },
}));

beforeEach(() => {
  vi.resetModules();
  runtimeMocks.ensureRemoteFile.mockReset();
  runtimeMocks.ensureRemoteFile.mockImplementation(
    async (options: { fileName: string; modelDir: string }) =>
      `${options.modelDir}/${options.fileName}`,
  );
  runtimeMocks.createSession.mockReset();
  runtimeMocks.createSession.mockResolvedValue({
    inputNames: ["input"],
    outputNames: ["dets", "labels", "masks"],
  });
});

describe("KoharuLayout native ONNX runtime", () => {
  it("downloads only the pinned Koharu model", async () => {
    const dataRoot = resolve("test-data");
    const { ensureKoharuLayoutAssets } =
      await import("../src/main/bubbleLayout/assets");
    const assets = await ensureKoharuLayoutAssets({ dataRoot });
    expect(runtimeMocks.ensureRemoteFile).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.ensureRemoteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        modelDir: resolve(
          dataRoot,
          "models",
          "bubble-layout",
          "koharu-layout-rfdetr-seg-2xl-1152",
        ),
        fileName: KOHARU_LAYOUT_ONNX_FILE,
        expectedSha256: KOHARU_LAYOUT_ONNX_SHA256,
        minimumBytes: KOHARU_LAYOUT_ONNX_BYTES,
        maximumBytes: KOHARU_LAYOUT_ONNX_BYTES,
      }),
    );
    expect(assets).toEqual({
      modelPath: `${resolve(
        dataRoot,
        "models",
        "bubble-layout",
        "koharu-layout-rfdetr-seg-2xl-1152",
      )}/${KOHARU_LAYOUT_ONNX_FILE}`,
    });
  });

  it("uses DirectML for AMD/NVIDIA/Intel Windows GPUs and falls back only to Koharu CPU", async () => {
    runtimeMocks.createSession
      .mockRejectedValueOnce(new Error("DML unavailable"))
      .mockResolvedValueOnce({
        inputNames: ["input"],
        outputNames: ["dets", "labels", "masks"],
      });
    const { getKoharuLayoutSession, resolveKoharuCpuThreadCount } =
      await import("../src/main/bubbleLayout/session");
    const modelPath = resolve("models", "koharu.onnx");
    const first = await getKoharuLayoutSession({
      modelPath,
      providerPreference: ["dml", "cpu"],
    });
    const second = await getKoharuLayoutSession({
      modelPath,
      providerPreference: ["dml", "cpu"],
    });
    expect(first.provider).toBe("cpu");
    expect(second.session).toBe(first.session);
    expect(runtimeMocks.createSession).toHaveBeenNthCalledWith(
      1,
      modelPath,
      expect.objectContaining({ executionProviders: ["dml"] }),
    );
    expect(runtimeMocks.createSession).toHaveBeenNthCalledWith(2, modelPath, {
      executionProviders: ["cpu"],
      executionMode: "sequential",
      graphOptimizationLevel: "all",
      intraOpNumThreads: resolveKoharuCpuThreadCount(),
      interOpNumThreads: 1,
      enableMemPattern: true,
    });
    expect(runtimeMocks.createSession).toHaveBeenCalledTimes(2);
  });

  it("does not turn cancellation into a CPU fallback", async () => {
    let releaseSession: ((value: unknown) => void) | undefined;
    runtimeMocks.createSession.mockImplementationOnce(
      () =>
        new Promise((resolvePromise) => {
          releaseSession = resolvePromise;
        }),
    );
    const controller = new AbortController();
    const { getKoharuLayoutSession } =
      await import("../src/main/bubbleLayout/session");
    const pending = getKoharuLayoutSession({
      modelPath: resolve("models", "cancelled-koharu.onnx"),
      providerPreference: ["dml", "cpu"],
      signal: controller.signal,
    });

    controller.abort();
    releaseSession?.({
      inputNames: ["input"],
      outputNames: ["dets", "labels", "masks"],
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(runtimeMocks.createSession).toHaveBeenCalledTimes(1);
  });

  it("serializes runs that share a DirectML session", async () => {
    const { withKoharuSessionLease } =
      await import("../src/main/bubbleLayout/session");
    const session = {} as never;
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const first = withKoharuSessionLease(session, undefined, async () => {
      events.push("first:start");
      await new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });
      events.push("first:end");
    });
    await vi.waitFor(() => expect(events).toEqual(["first:start"]));

    const second = withKoharuSessionLease(session, undefined, async () => {
      events.push("second:start");
      events.push("second:end");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });
});
