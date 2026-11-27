import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { InferenceUtilityProcess } from "../src/main/runtimeSupport/inferenceUtilityProcess";
import { serveInference } from "../src/main/runtimeSupport/inferenceUtilityHost";
import { modelCleanupIsBlocked } from "../src/main/runtimeSupport/modelCleanupBarrier";

const fork = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ utilityProcess: { fork } }));
beforeEach(() => fork.mockReset());

function child() {
  const proc = Object.assign(new EventEmitter(), {
    pid: 17 as number | undefined,
    postMessage: vi.fn(),
    kill: vi.fn(() => {
      queueMicrotask(() => proc.emit("exit", 0));
      return true;
    }),
  });
  return proc;
}

it("keeps the model between pages, skips a cancelled queued page and drains outstanding work on disposal", async () => {
  const proc = child();
  fork.mockReturnValue(proc);
  const service = new InferenceUtilityProcess<string, string>(
    "model.js",
    "model",
  );
  const first = service.run("first");
  await vi.waitFor(() =>
    expect(proc.postMessage).toHaveBeenCalledWith("first"),
  );
  const cancel = new AbortController();
  const skipped = service.run("skipped", cancel.signal);
  const last = service.run("last");
  const disposed = service.dispose();
  cancel.abort();
  await expect(skipped).rejects.toMatchObject({ name: "AbortError" });
  proc.emit("message", { ok: true, result: "one" });
  await expect(first).resolves.toBe("one");
  await vi.waitFor(() =>
    expect(proc.postMessage).toHaveBeenLastCalledWith("last"),
  );
  expect(proc.kill).not.toHaveBeenCalled();
  proc.emit("message", { ok: true, result: "three" });
  await expect(last).resolves.toBe("three");
  await expect(disposed).resolves.toBe(true);
  expect(fork).toHaveBeenCalledTimes(1);
  expect(fork).toHaveBeenCalledWith("model.js", [], { serviceName: "model" });
  expect(proc.postMessage).toHaveBeenCalledTimes(2);
  await expect(service.dispose()).resolves.toBe(false);
});

it("cancels before spawn, waits for confirmed exit and starts a fresh process after a crash", async () => {
  const first = child(),
    second = child(),
    third = child();
  first.pid = undefined;
  fork
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(second)
    .mockReturnValueOnce(third);
  const service = new InferenceUtilityProcess(
    "model.js",
    "test model",
    () => "test.log",
  );
  const controller = new AbortController();
  const active = service.run(1, controller.signal);
  await vi.waitFor(() => expect(first.postMessage).toHaveBeenCalledOnce());
  controller.abort();
  const next = service.run(2);
  await vi.waitFor(() => expect(modelCleanupIsBlocked()).toBe(true));
  first.pid = 19;
  first.emit("spawn");
  await expect(active).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(second.postMessage).toHaveBeenCalledOnce());
  second.emit("exit", 7);
  await expect(next).rejects.toThrow("exited (7)");
  const thirdRequest = service.run(3);
  await vi.waitFor(() => expect(third.postMessage).toHaveBeenCalledWith(3));
  third.emit("message", { ok: false, error: "model failure" });
  await expect(thirdRequest).rejects.toThrow("model failure");
  third.postMessage.mockImplementationOnce(() => {
    throw new Error("IPC closed");
  });
  await expect(service.run(4)).rejects.toThrow("IPC closed");
  await expect(service.run(5, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  await service.dispose();
  expect(modelCleanupIsBlocked()).toBe(false);
});

it("retains a failed termination receipt until a cleanup retry observes exit", async () => {
  const proc = child();
  fork.mockReturnValue(proc);
  const service = new InferenceUtilityProcess("model.js", "model");
  const result = service.run(1);
  await vi.waitFor(() => expect(proc.postMessage).toHaveBeenCalledOnce());
  proc.emit("message", { ok: true, result: 1 });
  await result;
  proc.kill.mockReturnValueOnce(false);
  await expect(service.dispose()).rejects.toThrow();
  expect(modelCleanupIsBlocked()).toBe(true);
  await expect(service.run(2)).rejects.toThrow();
  proc.pid = undefined;
  proc.emit("exit", 1);
  await expect(service.dispose()).resolves.toBe(true);
  expect(modelCleanupIsBlocked()).toBe(false);
});

it("runs the actual detector and Qwen process entries and returns errors over the utility port", async () => {
  const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const original = Object.getOwnPropertyDescriptor(process, "parentPort");
  try {
    Object.defineProperty(process, "parentPort", {
      configurable: true,
      value: null,
    });
    expect(() => serveInference(async () => 1)).toThrow("utility process");
    Object.defineProperty(process, "parentPort", {
      configurable: true,
      value: port,
    });
    await import("../src/main/bubbleLayout/nativeLayoutWorker");
    port.emit("message", {
      data: { bitmap: new Uint8Array(1), width: 5, height: 5 },
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({
        ok: false,
        error: expect.stringContaining("KoharuLayout"),
      }),
    );
    port.removeAllListeners();
    await import("../src/main/inpainting/qwenFloatWorker");
    port.emit("message", {
      data: { modelPath: "missing-model.onnx", threads: 1, inputs: [] },
    });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({
        ok: false,
        error: expect.stringContaining("missing-model.onnx"),
      }),
    );
    port.removeAllListeners();
    serveInference(async (value: number) => value * 2);
    port.emit("message", { data: 3 });
    await vi.waitFor(() =>
      expect(port.postMessage).toHaveBeenCalledWith({ ok: true, result: 6 }),
    );
  } finally {
    if (original) Object.defineProperty(process, "parentPort", original);
    else Reflect.deleteProperty(process, "parentPort");
  }
});
