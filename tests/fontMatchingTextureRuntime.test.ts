import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fontTextureParity.json";
import { prepareFontTextureSupport } from "../src/main/pipeline/fontMatchingTextureSupport";
import { loadFontTextureModel } from "../src/main/pipeline/fontMatchingTextureRuntime";
import {
  onnxRuntimeNode as ort,
  runDisposableFloatTensorStage,
} from "../src/main/runtimeSupport/nativeOnnxRuntime";
const bbox = { x: 0, y: 0, w: 1000, h: 1000 };
function raster(row: (typeof fixture.cases)[number]) {
  const rgb = Buffer.from(row.rgbBase64, "base64"),
    bgra = new Uint8Array(row.width * row.height * 4);
  for (let i = 0; i < row.width * row.height; i++) {
    bgra[i * 4] = rgb[i * 3 + 2];
    bgra[i * 4 + 1] = rgb[i * 3 + 1];
    bgra[i * 4 + 2] = rgb[i * 3];
    bgra[i * 4 + 3] = 255;
  }
  return { width: row.width, height: row.height, bgra };
}
describe("frozen intact-texture native parity", () => {
  for (const row of fixture.cases)
    it(`matches PIL/OpenCV source patches: ${row.name}`, () => {
      const support = prepareFontTextureSupport(raster(row), bbox);
      if (!support) throw new Error("Missing fixture texture support");
      expect(support.count).toBe(row.count);
      const expected = Buffer.from(row.patchUint8Base64, "base64");
      const actual = Buffer.from(
        support.values.map((v) => Math.round(v * 255)),
      );
      expect([...actual].filter((v, i) => v !== expected[i]).length).toBe(0);
    });
  it("abstains on empty pixels and honors cancellation", () => {
    const page = raster(fixture.cases[0]);
    page.bgra.fill(255);
    expect(prepareFontTextureSupport(page, bbox)).toBeNull();
    expect(() =>
      prepareFontTextureSupport(page, bbox, AbortSignal.abort()),
    ).toThrow();
  });
  it("runs exact CPU model through native gateway and matches Python logits", async () => {
    const session = await loadFontTextureModel();
    try {
      for (const row of fixture.cases) {
        const support = prepareFontTextureSupport(raster(row), bbox);
        if (!support) throw new Error("Missing fixture texture support");
        const actual = await runDisposableFloatTensorStage({
          session,
          inputName: "ink",
          outputName: "logits",
          input: new ort.Tensor("float32", support.values, [
            support.count,
            1,
            96,
            96,
          ]),
          expectedDimensions: [support.count, 15],
          consume: (v) => Array.from(v),
        });
        expect(
          Math.max(...actual.map((v, i) => Math.abs(v - row.logits.flat()[i]))),
        ).toBeLessThan(0.00005);
      }
    } finally {
      await session.release();
    }
  });
});
