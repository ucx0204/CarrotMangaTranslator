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

vi.mock("../src/main/runtimeSupport/nativeOnnxRuntime", () => ({
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
    release: vi.fn(),
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
        release: vi.fn(),
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

  it("retries a transiently unavailable GPU provider after the job releases its sessions", async () => {
    const cpuRelease = vi.fn(async () => undefined);
    const dmlRelease = vi.fn(async () => undefined);
    runtimeMocks.createSession
      .mockRejectedValueOnce(new Error("temporary DML allocation failure"))
      .mockResolvedValueOnce({
        inputNames: ["input"],
        outputNames: ["dets", "labels", "masks"],
        release: cpuRelease,
      })
      .mockResolvedValueOnce({
        inputNames: ["input"],
        outputNames: ["dets", "labels", "masks"],
        release: dmlRelease,
      });
    const { disposeCachedKoharuLayoutSessions, getKoharuLayoutSession } =
      await import("../src/main/bubbleLayout/session");
    const modelPath = resolve("models", "transient-dml-koharu.onnx");

    const first = await getKoharuLayoutSession({
      modelPath,
      providerPreference: ["dml", "cpu"],
    });
    expect(first.provider).toBe("cpu");
    await disposeCachedKoharuLayoutSessions();

    const second = await getKoharuLayoutSession({
      modelPath,
      providerPreference: ["dml", "cpu"],
    });
    expect(second.provider).toBe("dml");
    expect(runtimeMocks.createSession).toHaveBeenCalledTimes(3);
    await disposeCachedKoharuLayoutSessions();
    expect(cpuRelease).toHaveBeenCalledOnce();
    expect(dmlRelease).toHaveBeenCalledOnce();
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
      release: vi.fn(),
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

  it("releases the cached model session and creates a fresh one afterwards", async () => {
    const firstRelease = vi.fn(async () => undefined);
    const secondRelease = vi.fn(async () => undefined);
    runtimeMocks.createSession
      .mockResolvedValueOnce({
        inputNames: ["input"],
        outputNames: ["dets", "labels", "masks"],
        release: firstRelease,
      })
      .mockResolvedValueOnce({
        inputNames: ["input"],
        outputNames: ["dets", "labels", "masks"],
        release: secondRelease,
      });
    const { disposeCachedKoharuLayoutSessions, getKoharuLayoutSession } =
      await import("../src/main/bubbleLayout/session");
    const modelPath = resolve("models", "disposable-koharu.onnx");

    const first = await getKoharuLayoutSession({
      modelPath,
      providerPreference: ["cpu"],
    });
    await expect(disposeCachedKoharuLayoutSessions()).resolves.toBe(true);
    expect(firstRelease).toHaveBeenCalledTimes(1);

    const second = await getKoharuLayoutSession({
      modelPath,
      providerPreference: ["cpu"],
    });
    expect(second.session).not.toBe(first.session);
    expect(runtimeMocks.createSession).toHaveBeenCalledTimes(2);
    await expect(disposeCachedKoharuLayoutSessions()).resolves.toBe(true);
    expect(secondRelease).toHaveBeenCalledTimes(1);
    await expect(disposeCachedKoharuLayoutSessions()).resolves.toBe(false);
  });

  it("uses the platform provider preference when none is supplied", async () => {
    const { disposeCachedKoharuLayoutSessions, getKoharuLayoutSession } =
      await import("../src/main/bubbleLayout/session");

    await getKoharuLayoutSession({
      modelPath: resolve("models", "default-provider-koharu.onnx"),
    });

    expect(runtimeMocks.createSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionProviders: process.platform === "win32" ? ["dml"] : ["cpu"],
      }),
    );
    await expect(disposeCachedKoharuLayoutSessions()).resolves.toBe(true);
  });
});
