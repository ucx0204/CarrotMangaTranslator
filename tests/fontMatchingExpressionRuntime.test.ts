import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fontExpressionParity.json";
import { prepareFontExpressionSupport } from "../src/main/pipeline/fontMatchingExpressionSupport";
import { loadFontExpressionModel } from "../src/main/pipeline/fontMatchingExpressionRuntime";
import {
  onnxRuntimeNode as ort,
  runDisposableFloatTensorStage,
} from "../src/main/runtimeSupport/nativeOnnxRuntime";

function raster(inverted = false) {
  const gray = Buffer.from(fixture.grayBase64, "base64");
  const bgra = new Uint8Array(gray.length * 4);
  gray.forEach((value, index) => {
    bgra.fill(inverted ? 255 - value : value, index * 4, index * 4 + 3);
    bgra[index * 4 + 3] = 255;
  });
  return { width: fixture.width, height: fixture.height, bgra };
}
const bbox = { x: 0, y: 0, w: 1000, h: 1000 };

describe("bundled source expression model parity", () => {
  it("matches independent OpenCV component extraction and resizing, including polarity", () => {
    const prepared = prepareFontExpressionSupport(raster(), bbox);
    expect(prepared?.count).toBe(fixture.components);
    expect(prepared?.threshold).toBe(fixture.threshold);
    const bytes = Buffer.from(fixture.valuesFloat32Base64, "base64");
    const expected = new Float32Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.length / 4,
    );
    expect(prepared?.values.length).toBe(expected.length);
    const maximumError = Math.max(
      ...expected.map((value, i) =>
        Math.abs(value - (prepared?.values[i] ?? 100)),
      ),
    );
    expect(maximumError).toBeLessThan(0.000002);
    expect(prepareFontExpressionSupport(raster(true), bbox)?.values).toEqual(
      prepared?.values,
    );
  });

  it("returns no support for blank input and honors cancellation", () => {
    const page = raster();
    page.bgra.fill(255);
    expect(prepareFontExpressionSupport(page, bbox)).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      prepareFontExpressionSupport(raster(), bbox, controller.signal),
    ).toThrow();
  });

  it("loads the exact bundled bytes through the native gateway and matches Python logits", async () => {
    const session = await loadFontExpressionModel();
    try {
      const support = prepareFontExpressionSupport(raster(), bbox);
      if (!support) throw new Error("Missing reference support");
      const logits = await runDisposableFloatTensorStage({
        session,
        inputName: "ink",
        outputName: "logits",
        input: new ort.Tensor("float32", support.values, [
          support.count,
          1,
          64,
          64,
        ]),
        expectedDimensions: [support.count, 6],
        consume: (values) => Array.from(values),
      });
      expect(logits.length).toBe(fixture.logits.length);
      logits.forEach((value, index) =>
        expect(value).toBeCloseTo(fixture.logits[index], 4),
      );
    } finally {
      await session.release();
    }
  });
});
