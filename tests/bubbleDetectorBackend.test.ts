import { describe, expect, it, vi } from "vitest";
import { detectKoharuPageLayout } from "../src/main/bubbleLayout/detector";

describe("KoharuLayout detector backend", () => {
  it("routes the prepared page through the isolated WASM worker", async () => {
    const loadImage = vi.fn(async () => ({}) as never);
    const prepareImage = vi.fn(() => ({
      geometryRaster: {
        luminance: new Uint8Array([255]),
        width: 1,
        height: 1,
      },
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
    expect(result.geometryRaster?.luminance).toEqual(new Uint8Array([255]));
  });
});
