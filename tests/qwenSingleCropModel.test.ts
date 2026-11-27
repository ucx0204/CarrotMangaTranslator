import { expect, it } from "vitest";
import { declareQwenCropShape } from "../src/main/inpainting/qwenSingleCropModel";

it("retains ONNX operator bytes and opset while replacing the input/output descriptors", () => {
  const nodes = Buffer.alloc(160, 0x30);
  const original = Buffer.concat([
    Buffer.from([0x3a, 0xb0, 2]),
    nodes,
    Buffer.from([0x5a, 38, 10, 5, ...Buffer.from("image")]),
    Buffer.alloc(135),
    Buffer.from([0x42, 2, 16, 17]),
  ]);
  const result = declareQwenCropShape(original);
  expect(result?.subarray(3, 163).equals(nodes)).toBe(true);
  expect(result?.subarray(-4).toString("hex")).toBe("42021011");
  // FLOAT, rank four, fixed batch, three channels and two 512 axes.
  const rgb = Buffer.from(
    "0a16080112120a0208010a0208030a030880040a03088004",
    "hex",
  );
  expect(result?.indexOf(rgb)).toBeGreaterThan(163);
  expect(result?.lastIndexOf(rgb)).toBeGreaterThan(
    result?.indexOf(rgb) ?? Infinity,
  );
  expect(
    result?.includes(
      Buffer.from("0a0208010a0208010a030880040a03088004", "hex"),
    ),
  ).toBe(true);
  expect(declareQwenCropShape(Buffer.alloc(200))).toBeUndefined();
});
