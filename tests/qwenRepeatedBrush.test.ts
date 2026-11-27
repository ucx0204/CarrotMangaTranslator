import { areWhitePrintCropsRestored } from "../src/main/inpainting/qwenOverlappingPrint";
import type { FluxWindowProcessArgs } from "../src/main/inpainting/fluxEngineRunnerTypes";
import { describe, expect, it } from "vitest";
import { isRestoredBrushPrint } from "../src/main/inpainting/qwenRepeatedBrush";
function drawing() {
  const w = 92,
    h = 62,
    box = { x: 0, y: 0, w, h };
  const paper = Buffer.alloc(4 * w * h, 255);
  const args = {
    width: w,
    sourceBitmap: Buffer.from(paper),
    bitmap: Buffer.from(paper),
    contextBitmap: Buffer.from(paper),
  };
  const ink = { bounds: box, data: new Uint8Array(w * h) };
  const crop = {
    paddedBounds: box,
    localMask: new Uint8Array(w * h),
    validationMask: new Uint8Array(w * h),
  };
  const point = (x: number, y: number) => y * w + x;
  const level = (image: Buffer, x: number, y: number, l: number) =>
    image.fill(l, 4 * point(x, y), 4 * point(x, y) + 3);
  for (let y = 10; y < 42; y++)
    for (let x = 12; x < 69; x++) {
      ink.data[point(x, y)] = 1;
      level(args.sourceBitmap, x, y, 32);
      level(args.bitmap, x, y, 216 + ((x + 2 * y) % 25));
      level(args.contextBitmap, x, y, 216 + ((x + 2 * y) % 25));
    }
  const trace = (x: number, y: number, own = true) => {
    for (const b of [args.sourceBitmap, args.bitmap, args.contextBitmap])
      level(b, x, y, 30);
    if (own) crop.localMask[point(x, y)] = 1;
  };
  return {
    args,
    crop,
    ink,
    trace,
    point,
    level,
    run: () => isRestoredBrushPrint(args, crop, ink.data),
  };
}
describe("duplicate brush lettering on exposed drawing", () => {
  it("keeps dot-printed paper and an original line crossing the width of a stroke", () => {
    const d = drawing();
    for (let x = 3; x < 22; x++) d.trace(x, 23, x >= 12);
    expect(d.run()).toBe(true);
  });
  it("requires the remaining thin fragments to connect to original artwork", () => {
    const d = drawing();
    for (let x = 27; x < 35; x++) d.trace(x, 25);
    expect(d.run()).toBe(false);
  });
  it("continues inference when a separate thick face touches existing art", () => {
    const d = drawing();
    for (let y = 24; y < 29; y++)
      for (let x = 9; x <= 17; x++) d.trace(x, y, x >= 12);
    expect(d.run()).toBe(false);
  });
  it("requires both page buffers to show the original lettering has gone", () => {
    const d = drawing();
    d.args.contextBitmap = Buffer.from(d.args.sourceBitmap);
    expect(d.run()).toBe(false);
  });
  it("requires the repeated selection to have previously claimed dark faces", () => {
    const d = drawing();
    d.crop.localMask.set(d.ink.data);
    expect(d.run()).toBe(false);
  });
  it("accepts removed faces on light paper with no dark crossing", () => {
    expect(drawing().run()).toBe(true);
  });
  it("rejects transparent and incomplete page evidence", () => {
    const d = drawing();
    d.args.bitmap[4 * d.point(23, 20) + 3] = 0;
    expect(d.run()).toBe(false);
  });
  it("leaves unbounded tiles and clipped dark strokes for normal inference", () => {
    const d = drawing();
    d.crop.paddedBounds = { x: 0, y: 0, w: 2048, h: 2048 };
    expect(d.run()).toBe(false);
    const b = drawing();
    b.trace(0, 42);
    expect(b.run()).toBe(false);
  });
});

it("uses confirmed duplicates only for worker-resized brush selections", () => {
  const d = drawing();
  for (let x = 3; x < 22; x++) d.trace(x, 23, x >= 12);
  const box = d.crop.paddedBounds,
    prepared = {
      ...d.crop,
      processSize: { width: box.w, height: box.h },
      writeBounds: box,
    };
  const opts: FluxWindowProcessArgs = {
    ...d.args,
    height: box.h,
    index: 0,
    window: box,
    mask: d.crop.localMask,
    isolateWindowMasks: true,
    cropStrategy: "worker-resize",
    runDir: "",
    options: {
      featherPx: 2,
      contextPx: 40,
      maskPaddingPx: 4,
      maxPixels: 512 * 512,
    },
    getWorker: () => {
      throw Error("No model is needed to verify duplicate coverage");
    },
    runOptions: { illustratedTitleWindows: ["brush"], windowMasks: [d.ink] },
  };
  expect(areWhitePrintCropsRestored(opts, [prepared])).toBe(true);
  expect(
    areWhitePrintCropsRestored({ ...opts, cropStrategy: "native" }, [prepared]),
  ).toBe(false);
  expect(
    areWhitePrintCropsRestored(
      { ...opts, runOptions: { illustratedTitleWindows: ["brush"] } },
      [prepared],
    ),
  ).toBe(false);
  expect(
    areWhitePrintCropsRestored(
      { ...opts, runOptions: { windowMasks: [d.ink] } },
      [prepared],
    ),
  ).toBe(false);
});
