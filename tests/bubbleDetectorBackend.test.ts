import { describe, expect, it, vi } from "vitest";
import { detectKoharuPageLayout } from "../src/main/bubbleLayout/detector";

describe("KoharuLayout detector backend", () => {
  it("routes the prepared page through the isolated WASM worker", async () => {
    const loadImage = vi.fn(async () => ({}) as never);
    const prepareImage = vi.fn(() => ({
      imageWidth: 1200,
      imageHeight: 1800,
      rgbChw: new Float32Array(3),
    }));
    const resolveBackend = vi.fn(() => "wasm-worker" as const);
    const runWasmInference = vi.fn(async () => ({
      imageWidth: 1200,
      imageHeight: 1800,
      detections: [],
      executionProvider: "wasm" as const,
    }));
    const signal = new AbortController().signal;
    const result = await detectKoharuPageLayout(
      {
        imagePath: "page.png",
        modelPath: "koharu.onnx",
        signal,
      },
      {
        loadImage,
        prepareImage,
        resolveBackend,
        runWasmInference,
        runNativeInference: vi.fn(),
      },
    );

    expect(loadImage).toHaveBeenCalledWith("page.png", undefined);
    expect(runWasmInference).toHaveBeenCalledWith({
      modelPath: "koharu.onnx",
      imageWidth: 1200,
      imageHeight: 1800,
      rgbChw: expect.any(Float32Array),
      signal,
    });
    expect(result.executionProvider).toBe("wasm");
  });
  it("passes only the original crop pixels and model settings to the native process", async () => {
    const bitmap = Buffer.alloc(32, 91);
    const originalCrop = {
      getSize: () => ({ width: 4, height: 2 }),
      toBitmap: () => bitmap,
    } as Electron.NativeImage;
    const runNativeInference = vi.fn(async () => ({
      imageWidth: 4,
      imageHeight: 2,
      detections: [],
    }));
    const loadImage = vi.fn(),
      prepareImage = vi.fn(),
      runWasmInference = vi.fn();
    const signal = new AbortController().signal;
    await detectKoharuPageLayout(
      {
        imagePath: "original.jpg",
        originalCrop,
        modelPath: "model.onnx",
        directMl: { computeGpuIndex: 1 },
        providerPreference: ["dml", "cpu"],
        signal,
      },
      {
        resolveBackend: () => "native",
        runNativeInference,
        runWasmInference,
        loadImage,
        prepareImage,
      },
    );
    expect(runNativeInference).toHaveBeenCalledWith(
      {
        bitmap,
        width: 4,
        height: 2,
        modelPath: "model.onnx",
        directMl: { computeGpuIndex: 1 },
        providerPreference: ["dml", "cpu"],
      },
      signal,
    );
    for (const unused of [prepareImage, loadImage, runWasmInference])
      expect(unused).not.toHaveBeenCalled();
  });
});
