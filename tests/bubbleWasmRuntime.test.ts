import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KoharuWasmInferenceWorkerClient,
  resolveKoharuInferenceBackend,
  resolveKoharuWasmAssets,
  resolveKoharuWasmThreadCount,
} from "../src/main/bubbleLayout/wasmWorkerClient";
import type {
  KoharuWasmAssets,
  KoharuWasmWorkerInboundMessage,
} from "../src/main/bubbleLayout/wasmWorkerProtocol";

const WASM_ASSETS: KoharuWasmAssets = {
  wasmBinaryPath: resolve("ort.wasm"),
  wasmModulePath: resolve("ort.mjs"),
};

class FakeWorker extends EventEmitter {
  readonly messages: KoharuWasmWorkerInboundMessage[] = [];
  readonly terminate = vi.fn(async () => 0);

  postMessage(message: KoharuWasmWorkerInboundMessage): void {
    this.messages.push(message);
  }
}

const clients: KoharuWasmInferenceWorkerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
});

describe("KoharuLayout macOS WASM isolation", () => {
  it("routes macOS to the WASM worker while preserving native Windows inference", () => {
    expect(resolveKoharuInferenceBackend("darwin", {})).toBe("wasm-worker");
    expect(resolveKoharuInferenceBackend("win32", {})).toBe("native");
    expect(resolveKoharuInferenceBackend("linux", {})).toBe("native");
    expect(
      resolveKoharuInferenceBackend("darwin", {
        MANGA_TRANSLATOR_BUBBLE_LAYOUT_BACKEND: "native",
      }),
    ).toBe("native");
    expect(
      resolveKoharuInferenceBackend("win32", {
        MANGA_TRANSLATOR_BUBBLE_LAYOUT_BACKEND: "wasm",
      }),
    ).toBe("wasm-worker");
  });

  it("limits the dedicated worker to four threads and accepts a sealed override", () => {
    expect(resolveKoharuWasmThreadCount({}, 1)).toBe(1);
    expect(resolveKoharuWasmThreadCount({}, 6)).toBe(3);
    expect(resolveKoharuWasmThreadCount({}, 32)).toBe(4);
    expect(
      resolveKoharuWasmThreadCount(
        { MANGA_TRANSLATOR_BUBBLE_LAYOUT_THREADS: "8" },
        2,
      ),
    ).toBe(8);
    expect(
      resolveKoharuWasmThreadCount(
        { MANGA_TRANSLATOR_BUBBLE_LAYOUT_THREADS: "9" },
        32,
      ),
    ).toBe(4);
  });

  it("verifies and resolves the pinned ORT-Web assets", async () => {
    const assets = await resolveKoharuWasmAssets(resolve("missing-runtime"));
    expect(assets.wasmModulePath).toMatch(
      /onnxruntime-web[\\/]dist[\\/]ort-wasm-simd-threaded\.mjs$/u,
    );
    expect(assets.wasmBinaryPath).toMatch(
      /onnxruntime-web[\\/]dist[\\/]ort-wasm-simd-threaded\.wasm$/u,
    );
  });

  it("transfers inference input and accepts a matching WASM result", async () => {
    const worker = new FakeWorker();
    const client = makeClient(worker);
    const input = new Float32Array(3 * 1152 * 1152);
    const pending = client.infer({
      modelPath: resolve("koharu.onnx"),
      imageWidth: 1200,
      imageHeight: 1800,
      rgbChw: input,
    });
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    const request = worker.messages[0];
    expect(request).toMatchObject({
      type: "infer",
      imageWidth: 1200,
      imageHeight: 1800,
      threadCount: 2,
      wasmAssets: WASM_ASSETS,
    });
    if (!request || request.type !== "infer") {
      throw new Error("Expected a Koharu infer request.");
    }
    worker.emit("message", {
      type: "infer-done",
      id: request.id,
      ok: true,
      result: {
        imageWidth: 1200,
        imageHeight: 1800,
        detections: [],
        executionProvider: "wasm",
      },
    });
    await expect(pending).resolves.toMatchObject({
      imageWidth: 1200,
      imageHeight: 1800,
      executionProvider: "wasm",
    });
  });

  it("contains worker crashes as request errors instead of process crashes", async () => {
    const worker = new FakeWorker();
    const client = makeClient(worker);
    const pending = client.infer({
      modelPath: resolve("koharu.onnx"),
      imageWidth: 1,
      imageHeight: 1,
      rgbChw: new Float32Array(3 * 1152 * 1152),
    });
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    worker.emit("error", new Error("worker crash"));
    await expect(pending).rejects.toThrow("worker crash");
  });

  it("forwards cancellation and rejects with AbortError", async () => {
    const worker = new FakeWorker();
    const client = makeClient(worker);
    const controller = new AbortController();
    const pending = client.infer({
      modelPath: resolve("koharu.onnx"),
      imageWidth: 1,
      imageHeight: 1,
      rgbChw: new Float32Array(3 * 1152 * 1152),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    const request = worker.messages[0];
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.messages.at(-1)).toEqual({
      type: "cancel",
      id: request?.id,
    });
  });

  it("rejects malformed success messages and terminates on disposal", async () => {
    const worker = new FakeWorker();
    const client = makeClient(worker);
    const pending = client.infer({
      modelPath: resolve("koharu.onnx"),
      imageWidth: 100,
      imageHeight: 200,
      rgbChw: new Float32Array(3 * 1152 * 1152),
    });
    await vi.waitFor(() => expect(worker.messages).toHaveLength(1));
    const request = worker.messages[0];
    worker.emit("message", {
      type: "infer-done",
      id: request?.id,
      ok: true,
      result: {
        imageWidth: 101,
        imageHeight: 200,
        detections: [],
        executionProvider: "wasm",
      },
    });
    await expect(pending).rejects.toThrow("invalid result");
    await expect(client.dispose()).resolves.toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

function makeClient(worker: FakeWorker): KoharuWasmInferenceWorkerClient {
  const client = new KoharuWasmInferenceWorkerClient({
    resolveWorkerScript: () => resolve("wasmWorker.js"),
    resolveWasmAssets: async () => WASM_ASSETS,
    spawnWorker: () => worker as never,
    threadCount: 2,
  });
  clients.push(client);
  return client;
}
