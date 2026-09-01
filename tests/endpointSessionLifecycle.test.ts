import { describe, expect, it, vi } from "vitest";
import { startAnalysisEndpointSession } from "../src/main/pipeline/endpointSession";
import type { JobEvent } from "../src/shared/jobTypes";

type EndpointArgs = Parameters<typeof startAnalysisEndpointSession>[0];

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

describe("analysis endpoint session lifecycle", () => {
  it("shares one in-flight dispose promise across concurrent callers", async () => {
    const disposeGate = createDeferred<void>();
    const dispose = vi.fn(() => disposeGate.promise);
    const { args } = makeEndpointArgs({ dispose });
    const session = await startAnalysisEndpointSession(args);

    const first = session.disposeEndpointSession();
    const second = session.disposeEndpointSession();
    await Promise.resolve();

    expect(dispose).toHaveBeenCalledTimes(1);
    let settled = 0;
    void first.then(() => settled++);
    void second.then(() => settled++);
    await Promise.resolve();
    expect(settled).toBe(0);

    disposeGate.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("shares the same dispose rejection without retrying", async () => {
    const failure = new Error("dispose failed");
    const disposeGate = createDeferred<void>();
    const dispose = vi.fn(() => disposeGate.promise);
    const { args } = makeEndpointArgs({ dispose });
    const session = await startAnalysisEndpointSession(args);

    const first = session.disposeEndpointSession();
    const second = session.disposeEndpointSession();
    disposeGate.reject(failure);
    const results = await Promise.allSettled([first, second]);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
  });

  it("registers cleanup then disposes and aborts when startup finishes after cancellation", async () => {
    const controller = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const onCleanupReady = vi.fn();
    const events: JobEvent[] = [];
    const { args, startEndpointSession } = makeEndpointArgs({
      controller,
      dispose,
      emit: (event) => events.push(event),
      onCleanupReady,
    });
    startEndpointSession.mockImplementation(async () => {
      controller.abort();
      return makeRawEndpointSession(dispose);
    });

    await expect(startAnalysisEndpointSession(args)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(onCleanupReady).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.phase === "ready")).toBe(false);
  });

  it("disposes the endpoint when cleanup registration throws", async () => {
    const failure = new Error("registrar failed");
    const dispose = vi.fn(async () => undefined);
    const { args } = makeEndpointArgs({
      dispose,
      onCleanupReady: () => {
        throw failure;
      },
    });

    await expect(startAnalysisEndpointSession(args)).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the endpoint when the ready event throws", async () => {
    const failure = new Error("ready emit failed");
    const dispose = vi.fn(async () => undefined);
    const emit = vi.fn((event: JobEvent) => {
      if (event.phase === "ready") {
        throw failure;
      }
    });
    const { args } = makeEndpointArgs({ dispose, emit });

    await expect(startAnalysisEndpointSession(args)).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

function makeEndpointArgs({
  controller = new AbortController(),
  dispose,
  emit = vi.fn(),
  onCleanupReady,
}: {
  controller?: AbortController;
  dispose: () => Promise<void>;
  emit?: (event: JobEvent) => void;
  onCleanupReady?: EndpointArgs["onCleanupReady"];
}): {
  args: EndpointArgs;
  startEndpointSession: ReturnType<typeof vi.fn>;
} {
  const startEndpointSession = vi.fn(async () =>
    makeRawEndpointSession(dispose),
  );
  const runtimeFixture: Partial<EndpointArgs["runtime"]> = {
    startEndpointSession,
  };
  const runtime = runtimeFixture as EndpointArgs["runtime"];
  const baseOptionsFixture: Partial<EndpointArgs["baseOptions"]> = {
    abortSignal: controller.signal,
    gemmaVramMode: "minimum12b",
    modelFile: "model.gguf",
    port: 12345,
  };
  const baseOptions = baseOptionsFixture as EndpointArgs["baseOptions"];

  return {
    args: {
      apiSelected: false,
      baseOptions,
      codexSelected: false,
      formatGemmaVramMode: () => "auto",
      localModelSelected: false,
      modelCached: true,
      onCleanupReady,
      progressContext: {
        jobId: "job-1",
        emit,
        progressTotal: 1,
        pageTotal: 1,
        ocrPipeline: "paddle-legacy",
      },
      runtime,
    },
    startEndpointSession,
  };
}

function makeRawEndpointSession(dispose: () => Promise<void>) {
  return {
    handle: { baseUrl: "http://127.0.0.1:12345" },
    dispose,
  } as Awaited<ReturnType<EndpointArgs["runtime"]["startEndpointSession"]>>;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
