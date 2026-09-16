import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { KoharuWasmInferenceWorkerClient } from "../src/main/bubbleLayout/wasmWorkerClient";
import { assertModelCleanupComplete } from "../src/main/runtimeSupport/modelCleanupBarrier";
import type { KoharuWasmWorkerInboundMessage } from "../src/main/bubbleLayout/wasmWorkerProtocol";

const assets = { wasmBinaryPath: resolve("fixture.wasm"), wasmModulePath: resolve("fixture.mjs") };
const input = () => ({ modelPath: resolve("fixture.onnx"), imageWidth: 1, imageHeight: 1, rgbChw: new Float32Array(3) });
class WorkerFixture extends EventEmitter {
  readonly messages: KoharuWasmWorkerInboundMessage[] = [];
  readonly terminate = vi.fn(async () => 0);
  postMessage(message: KoharuWasmWorkerInboundMessage) { this.messages.push(message); }
}
function fixture() {
  const worker = new WorkerFixture();
  const spawnWorker = vi.fn(() => worker as never);
  const resolveWasmAssets = vi.fn(async () => assets);
  const client = new KoharuWasmInferenceWorkerClient({ resolveWorkerScript: () => resolve("fixture-worker.js"), spawnWorker, resolveWasmAssets, threadCount: 1 });
  return { client, worker, spawnWorker, resolveWasmAssets };
}
async function settleInference(f: ReturnType<typeof fixture>) {
  const inference = f.client.infer(input());
  await vi.waitFor(() => expect(f.worker.messages).toHaveLength(1));
  f.worker.emit("message", { type: "infer-done", id: f.worker.messages[0].id, ok: true, result: { imageWidth: 1, imageHeight: 1, detections: [], executionProvider: "wasm" } });
  await inference;
}

it("awaits native termination and fences other models until cleanup acknowledgement", async () => {
  const f = fixture();
  await settleInference(f);
  let finish!: (value: number) => void;
  f.worker.terminate.mockImplementationOnce(() => new Promise<number>((resolveDone) => { finish = resolveDone; }));
  let closed = false;
  const closing = f.client.dispose().then(() => { closed = true; });
  try {
    await vi.waitFor(() => expect(f.worker.terminate).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    expect(() => assertModelCleanupComplete()).toThrow();
    await expect(f.client.infer(input())).rejects.toThrow(/disposed/);
    finish(0);
    await closing;
    expect(() => assertModelCleanupComplete()).not.toThrow();
    await expect(f.client.dispose()).resolves.toBe(false);
  } finally {
    finish?.(0);
    await closing;
    await f.client.dispose();
  }
});

it("retains a failed worker handle until an explicit cleanup retry succeeds", async () => {
  const f = fixture();
  await settleInference(f);
  f.worker.terminate.mockRejectedValueOnce(new Error("termination not confirmed"));
  try {
    await expect(f.client.dispose()).rejects.toMatchObject({ code: "MODEL_CLEANUP_INCOMPLETE" });
    expect(() => assertModelCleanupComplete()).toThrow();
    await expect(f.client.infer(input())).rejects.toThrow(/disposed/);
    await expect(f.client.dispose()).resolves.toBe(true);
    expect(f.worker.terminate).toHaveBeenCalledTimes(2);
    expect(() => assertModelCleanupComplete()).not.toThrow();
  } finally { await f.client.dispose(); }
});

it("does not spawn a model worker after disposal during asynchronous asset resolution", async () => {
  const f = fixture();
  let ready!: (value: typeof assets) => void;
  f.resolveWasmAssets.mockImplementationOnce(() => new Promise((resolveReady) => { ready = resolveReady; }));
  const inference = f.client.infer(input());
  const rejected = expect(inference).rejects.toThrow(/closing/);
  try {
    await expect(f.client.dispose()).resolves.toBe(false);
    ready(assets);
    await rejected;
    expect(f.spawnWorker).not.toHaveBeenCalled();
  } finally { ready?.(assets); await f.client.dispose(); }
});

it.each(["error", "exit"] as const)("preserves the worker handle on %s until the finalizer acknowledges termination", async (event) => {
  const f = fixture();
  const inference = f.client.infer(input());
  const rejected = expect(inference).rejects.toThrow();
  await vi.waitFor(() => expect(f.worker.messages).toHaveLength(1));
  f.worker.emit(event, event === "error" ? new Error("native worker crash") : 1);
  try {
    await rejected;
    await expect(f.client.dispose()).resolves.toBe(true);
    expect(f.worker.terminate).toHaveBeenCalledOnce();
    await expect(f.client.infer(input())).rejects.toThrow(/disposed/);
  } finally { await f.client.dispose(); }
});
