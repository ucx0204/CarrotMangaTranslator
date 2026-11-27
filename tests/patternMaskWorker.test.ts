import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { makePage } from "./koharuTypographyMask.fixture";
import { buildPatternPageMask } from "../src/main/inpainting/patternPageMask";

const originalType = Object.getOwnPropertyDescriptor(process, "type");
afterEach(() => {
  if (originalType) Object.defineProperty(process, "type", originalType);
  else Reflect.deleteProperty(process, "type");
  vi.doUnmock("node:worker_threads");
  vi.resetModules();
});
function input() {
  const page = makePage();
  return {
    page,
    bitmap: Buffer.alloc(64 * 64 * 4, 255),
    width: 64,
    height: 64,
    conditionOnTypography: true,
    mode: "flux-region" as const,
  };
}
it("transfers the normal page mask and shared bindings from the worker exactly once", async () => {
  const opts = input(),
    native = buildPatternPageMask(opts);
  const send = vi.fn();
  vi.doMock("node:worker_threads", () => ({
    isMainThread: false,
    workerData: {
      kind: "pattern-page-mask",
      options: {
        ...opts,
        bitmap: Uint8Array.from(opts.bitmap),
        sourceEvidenceBitmap: opts.bitmap,
      },
    },
    parentPort: { postMessage: send },
    Worker: class {},
  }));
  const { preparePatternPageMask } =
    await import("../src/main/inpainting/patternMaskWorker");
  expect(send).toHaveBeenCalledOnce();
  const [ctx, buffers] = send.mock.calls[0];
  expect(ctx).toEqual(native);
  expect(buffers).toEqual([...new Set(buffers)]);
  expect(buffers).toContain(ctx.pageMask.buffer);
  expect(await preparePatternPageMask(opts)).toEqual(native);
});
it("isolates a large Qwen raster scan and settles cancellation, exit, and errors", async () => {
  Object.defineProperty(process, "type", {
    value: "browser",
    configurable: true,
  });
  const workers: MockWorker[] = [];
  class MockWorker extends EventEmitter {
    constructor(
      _f: string,
      readonly options: { workerData: { options: ReturnType<typeof input> } },
    ) {
      super();
      workers.push(this);
    }
    terminate = vi.fn(async () => 1);
  }
  vi.doMock("node:worker_threads", () => ({
    isMainThread: true,
    workerData: null,
    parentPort: null,
    Worker: MockWorker,
  }));
  const { preparePatternPageMask } =
    await import("../src/main/inpainting/patternMaskWorker");
  const opts = input(),
    empty = buildPatternPageMask(opts);
  expect(await preparePatternPageMask(opts)).toEqual(empty);
  const large = {
    ...opts,
    width: 800,
    height: 800,
    page: { ...opts.page, width: 800, height: 800, dataUrl: "unused preview" },
  };
  const result = preparePatternPageMask(large);
  expect(workers[0].options.workerData.options.page.dataUrl).toBe("");
  workers[0].emit("message", empty);
  expect(await result).toEqual(empty);
  const stopped = new AbortController();
  const cancelled = preparePatternPageMask({
    ...large,
    signal: stopped.signal,
  });
  stopped.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(workers[1].terminate).toHaveBeenCalledOnce();
  await expect(
    preparePatternPageMask({ ...large, signal: stopped.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const crashed = preparePatternPageMask(large);
  workers[2].emit("error", new Error("read failure"));
  await expect(crashed).rejects.toThrow("read failure");
  const exited = preparePatternPageMask(large);
  workers[3].emit("exit", 1);
  await expect(exited).rejects.toThrow("종료");
});
