import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KOHARU_LAYOUT_ONNX_BYTES,
  KOHARU_LAYOUT_ONNX_FILE,
  KOHARU_LAYOUT_ONNX_SHA256,
} from "../src/main/bubbleLayout/constants";

const runtimeMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  ensureRemoteFile: vi.fn(),
  execFile: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../src/main/logger", () => ({
  logInfo: runtimeMocks.logInfo,
  logWarn: runtimeMocks.logWarn,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: runtimeMocks.execFile,
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
    Tensor: class {
      dispose = vi.fn();
      constructor(
        readonly type: string,
        readonly data: Float32Array,
        readonly dims: number[],
      ) {}
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  runtimeMocks.logInfo.mockReset();
  runtimeMocks.logWarn.mockReset();
  runtimeMocks.execFile.mockReset();
  runtimeMocks.execFile.mockImplementation(
    (_file, _args, _options, callback) => {
      callback(
        null,
        JSON.stringify({
          adapters: [
            {
              deviceId: 0,
              name: "Radeon iGPU",
              luid: "0000000000000001",
              highPerformanceRank: 1,
              dedicatedVideoMemory: 512,
            },
            {
              deviceId: 1,
              name: "NVIDIA dGPU",
              luid: "0000000000000002",
              highPerformanceRank: 0,
              dedicatedVideoMemory: 6144,
            },
          ],
          cudaLuid: "0000000000000002",
        }),
      );
    },
  );
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

describe("Text Detector DirectML device-loss recovery (#103)", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) throw new Error("Missing process.platform descriptor");
  const deviceLost = new Error(
    "Non-zero status code returned while running DmlFusedNode_0_0 node. " +
      "DirectML execution failed because of a device-lost / removal-class error. " +
      "ExecuteCommandList HRESULT=0x887A0006",
  );

  beforeEach(() =>
    Object.defineProperty(process, "platform", { value: "win32" }),
  );
  afterEach(() => Object.defineProperty(process, "platform", platform));

  async function setupDetector(failure: Error = deviceLost) {
    type Feeds = { input: { dispose: ReturnType<typeof vi.fn> } };
    const events: string[] = [];
    const gpu = {
      inputNames: ["input"],
      outputNames: ["dets", "labels", "masks"],
      run: vi.fn(async (_feeds: Feeds) => {
        throw failure;
      }),
      release: vi.fn(async () => {
        events.push("gpu-released");
      }),
    };
    const outputs = {
      dets: {
        data: new Float32Array(300 * 4),
        dims: [1, 300, 4],
        dispose: vi.fn(),
      },
      labels: {
        data: new Float32Array(300 * 5).fill(-20),
        dims: [1, 300, 5],
        dispose: vi.fn(),
      },
      masks: {
        data: new Proxy({ length: 300 * 288 ** 2 } as ArrayLike<number>, {
          get: (target, key) => (key === "length" ? target.length : 1),
        }),
        dims: [1, 300, 288, 288],
        dispose: vi.fn(),
      },
    };
    outputs.dets.data.set([0.5, 0.5, 0.25, 0.25]);
    outputs.labels.data[0] = 5;
    const cpu = {
      inputNames: ["input"],
      outputNames: ["dets", "labels", "masks"],
      run: vi.fn(async (_feeds: Feeds) => outputs),
      release: vi.fn(async () => undefined),
    };
    runtimeMocks.createSession.mockImplementation(async (_path, options) => {
      if (options.executionProviders[0] === "cpu") {
        events.push("cpu-created");
        return cpu;
      }
      return gpu;
    });
    const { detectKoharuPageLayout } =
      await import("../src/main/bubbleLayout/detector");
    const { prepareComicDetectorImage } =
      await import("../src/main/bubbleLayout/preprocess");
    const sessions = await import("../src/main/bubbleLayout/session");
    const image: Partial<Electron.NativeImage> = {
      getSize: () => ({ width: 240, height: 360 }),
      resize: (): Electron.NativeImage =>
        ({
          getSize: () => ({ width: 1152, height: 1152 }),
          isEmpty: () => false,
          toBitmap: () => Buffer.alloc(1152 * 1152 * 4, 128),
        }) as Electron.NativeImage,
    };
    const detect = (signal?: AbortSignal) =>
      detectKoharuPageLayout(
        {
          modelPath: "device-lost.onnx",
          imagePath: "original.png",
          signal,
        },
        {
          loadImage: async () => image as Electron.NativeImage,
          prepareImage: prepareComicDetectorImage,
          resolveBackend: () => "native",
          runWasmInference: vi.fn(),
        },
      );
    return { detect, gpu, cpu, outputs, events, ...sessions };
  }

  it("replays the same input on CPU and keeps later pages away from the lost device", async () => {
    const {
      detect,
      gpu,
      cpu,
      outputs,
      events,
      disposeCachedKoharuLayoutSessions,
    } = await setupDetector();
    const first = await detect();
    const second = await detect();
    expect(first.executionProvider).toBe("cpu");
    expect(first.detections[0]).toMatchObject({
      label: "text",
      box: [90, 135, 150, 225],
    });
    expect(second).toEqual(first);
    expect(gpu.run).toHaveBeenCalledOnce();
    expect(cpu.run).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.createSession).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["gpu-released", "cpu-created"]);
    const gpuInput = gpu.run.mock.calls[0][0].input;
    expect(cpu.run.mock.calls[0][0].input).toBe(gpuInput);
    expect(gpuInput.dispose).toHaveBeenCalledOnce();
    for (const output of Object.values(outputs))
      expect(output.dispose).toHaveBeenCalledTimes(2);
    await disposeCachedKoharuLayoutSessions();
    expect(gpu.release).toHaveBeenCalledOnce();
    expect(cpu.release).toHaveBeenCalledOnce();
  });

  it("does not run a queued page on a retired GPU session or release it twice", async () => {
    const { detect, gpu, cpu, disposeCachedKoharuLayoutSessions } =
      await setupDetector();
    let failGpu!: (error: Error) => void;
    gpu.run.mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          failGpu = reject;
        }),
    );
    const first = detect();
    await vi.waitFor(() => expect(gpu.run).toHaveBeenCalledOnce());
    const second = detect();
    await vi.waitFor(() =>
      expect(runtimeMocks.createSession).toHaveBeenCalledOnce(),
    );
    failGpu(deviceLost);
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.executionProvider)).toEqual([
      "cpu",
      "cpu",
    ]);
    expect(gpu.run).toHaveBeenCalledOnce();
    expect(cpu.run).toHaveBeenCalledTimes(2);
    await disposeCachedKoharuLayoutSessions();
    expect(gpu.release).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("invalid input dimensions"),
    new DOMException("887A0006", "AbortError"),
    new AggregateError([deviceLost], "887A0006"),
  ])(
    "does not turn an unrelated failure or cancellation into CPU processing: %s",
    async (failure) => {
      const { detect, cpu, disposeCachedKoharuLayoutSessions } =
        await setupDetector(failure);
      await expect(detect()).rejects.toBe(failure);
      expect(cpu.run).not.toHaveBeenCalled();
      expect(runtimeMocks.createSession).toHaveBeenCalledOnce();
      await disposeCachedKoharuLayoutSessions();
    },
  );

  it("honors cancellation during a device-lost run", async () => {
    const { detect, gpu, cpu, disposeCachedKoharuLayoutSessions } =
      await setupDetector();
    const controller = new AbortController();
    gpu.run.mockImplementationOnce(async () => {
      controller.abort();
      throw deviceLost;
    });
    await expect(detect(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cpu.run).not.toHaveBeenCalled();
    expect(runtimeMocks.createSession).toHaveBeenCalledOnce();
    await disposeCachedKoharuLayoutSessions();
    expect(gpu.release).toHaveBeenCalledOnce();
  });

  it("rejects an already queued lease before it can run the retired session", async () => {
    const {
      getKoharuLayoutSession,
      withKoharuSessionLease,
      gpu,
      disposeCachedKoharuLayoutSessions,
    } = await setupDetector();
    const { session } = await getKoharuLayoutSession({
      modelPath: "device-lost.onnx",
      providerPreference: ["dml", "cpu"],
    });
    const queuedRun = vi.fn(async () => undefined);
    const first = withKoharuSessionLease(session, undefined, async () => {
      throw deviceLost;
    });
    const second = withKoharuSessionLease(session, undefined, queuedRun);
    const results = await Promise.allSettled([first, second]);
    expect(results).toEqual([
      { status: "rejected", reason: deviceLost },
      { status: "rejected", reason: deviceLost },
    ]);
    expect(queuedRun).not.toHaveBeenCalled();
    await disposeCachedKoharuLayoutSessions();
    expect(gpu.release).toHaveBeenCalledOnce();
  });

  it("propagates CPU inference failure without retrying the GPU", async () => {
    const { detect, gpu, cpu, disposeCachedKoharuLayoutSessions } =
      await setupDetector();
    const cpuFailure = new Error("CPU allocation failed");
    cpu.run.mockRejectedValueOnce(cpuFailure);
    await expect(detect()).rejects.toMatchObject({
      errors: [deviceLost, cpuFailure],
    });
    expect(gpu.run).toHaveBeenCalledOnce();
    expect(cpu.run).toHaveBeenCalledOnce();
    await disposeCachedKoharuLayoutSessions();
  });

  it("releases CPU outputs if cancellation arrives as fallback inference completes", async () => {
    const { detect, cpu, outputs, disposeCachedKoharuLayoutSessions } =
      await setupDetector();
    const controller = new AbortController();
    cpu.run.mockImplementationOnce(async () => {
      controller.abort();
      return outputs;
    });
    await expect(detect(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    for (const output of Object.values(outputs))
      expect(output.dispose).toHaveBeenCalledOnce();
    await disposeCachedKoharuLayoutSessions();
  });

  it("preserves both device and cleanup failures without starting another provider", async () => {
    const { detect, gpu, cpu, disposeCachedKoharuLayoutSessions } =
      await setupDetector();
    const releaseFailure = new Error("release failed");
    gpu.release.mockRejectedValueOnce(releaseFailure);
    await expect(detect()).rejects.toMatchObject({
      errors: [deviceLost, releaseFailure],
    });
    expect(cpu.run).not.toHaveBeenCalled();
    await expect(disposeCachedKoharuLayoutSessions()).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(gpu.release).toHaveBeenCalledOnce();
  });

  it.each([
    "0x887A0005",
    "887A0006",
    "0x887a0007",
    "0x887A0020",
    "DXGI_ERROR_DEVICE_REMOVED",
  ])("recognizes the native device-loss code %s", async (code) => {
    const { isKoharuDeviceLostError } =
      await import("../src/main/bubbleLayout/session");
    expect(isKoharuDeviceLostError(new Error(code))).toBe(true);
    expect(isKoharuDeviceLostError({ message: code })).toBe(false);
  });
});

afterEach(() => vi.unstubAllEnvs());

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
      expect.objectContaining({
        executionProviders: [{ name: "dml", deviceId: 0 }],
      }),
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

    await vi.waitFor(() => expect(releaseSession).toBeTypeOf("function"));
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
        executionProviders:
          process.platform === "win32"
            ? [{ name: "dml", deviceId: 0 }]
            : ["cpu"],
      }),
    );
    await expect(disposeCachedKoharuLayoutSessions()).resolves.toBe(true);
  });
});

describe("KoharuLayout DirectML adapter routing", () => {
  it("maps the high-performance LUID to DXGI's ordinal and caches the selection", async () => {
    const { getKoharuLayoutSession } =
      await import("../src/main/bubbleLayout/session");
    const options = {
      modelPath: "hybrid.onnx",
      providerPreference: ["dml", "cpu"] as const,
      directMl: { graphicsGpuPreference: "high-performance" as const },
    };
    await getKoharuLayoutSession(options);
    await getKoharuLayoutSession(options);
    expect(runtimeMocks.createSession).toHaveBeenCalledOnce();
    expect(runtimeMocks.execFile).toHaveBeenCalledOnce();
    expect(runtimeMocks.logInfo).toHaveBeenCalledWith(
      "KoharuLayout execution provider ready",
      expect.objectContaining({
        adapter: expect.objectContaining({
          deviceId: 1,
          name: "NVIDIA dGPU",
          luid: "0000000000000002",
        }),
      }),
    );
    expect(runtimeMocks.createSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionProviders: [{ name: "dml", deviceId: 1 }],
      }),
    );
  });

  it("maps CUDA 0 to DXGI 1 by LUID, independently of graphics preference", async () => {
    vi.stubEnv("CUDA_DEVICE_ORDER", "PCI_BUS_ID");
    vi.stubEnv("CUDA_VISIBLE_DEVICES", "7");
    const { getKoharuLayoutSession } =
      await import("../src/main/bubbleLayout/session");
    await getKoharuLayoutSession({
      modelPath: "cuda.onnx",
      providerPreference: ["dml", "cpu"],
      directMl: { computeGpuBackend: "cuda", computeGpuIndex: 0 },
    });
    expect(runtimeMocks.execFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        windowsHide: true,
        timeout: 15_000,
        env: expect.objectContaining({ CUDA_VISIBLE_DEVICES: "0" }),
      }),
      expect.any(Function),
    );
    expect(runtimeMocks.createSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionProviders: [{ name: "dml", deviceId: 1 }],
      }),
    );
    expect(runtimeMocks.execFile.mock.calls[0][2].env).not.toHaveProperty(
      "CUDA_DEVICE_ORDER",
    );
  });

  it("creates a separate session after the GPU preference changes", async () => {
    const { getKoharuLayoutSession } =
      await import("../src/main/bubbleLayout/session");
    const options = {
      modelPath: "settings.onnx",
      providerPreference: ["dml", "cpu"] as const,
    };
    await getKoharuLayoutSession({
      ...options,
      directMl: { graphicsGpuPreference: "auto" },
    });
    await getKoharuLayoutSession({
      ...options,
      directMl: { graphicsGpuPreference: "high-performance" },
    });
    expect(
      runtimeMocks.createSession.mock.calls.map(
        (call) => call[1].executionProviders,
      ),
    ).toEqual([[{ name: "dml", deviceId: 0 }], [{ name: "dml", deviceId: 1 }]]);
  });

  it("falls back to CPU once when adapter mapping fails, then retries after disposal", async () => {
    runtimeMocks.execFile.mockImplementation(
      (_file, _args, _options, callback) =>
        callback(new Error("DXGI probe failed")),
    );
    const { getKoharuLayoutSession, disposeCachedKoharuLayoutSessions } =
      await import("../src/main/bubbleLayout/session");
    const options = {
      modelPath: "failure.onnx",
      providerPreference: ["dml", "cpu"] as const,
    };
    expect((await getKoharuLayoutSession(options)).provider).toBe("cpu");
    await getKoharuLayoutSession(options);
    expect(runtimeMocks.execFile).toHaveBeenCalledOnce();
    expect(
      runtimeMocks.createSession.mock.calls[0][1].executionProviders,
    ).toEqual(["cpu"]);
    await disposeCachedKoharuLayoutSessions();
    await getKoharuLayoutSession(options);
    expect(runtimeMocks.execFile).toHaveBeenCalledTimes(2);
  });
});
