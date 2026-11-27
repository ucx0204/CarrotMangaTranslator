import { assert, describe, expect, it } from "vitest";
import { measureQwenFramedScreen } from "../src/main/inpainting/qwenFramedScreen";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { distanceToMask } from "../src/main/inpainting/pageMaskComposite";

const width = 190,
  height = 220;
const bounds = { x: 0, y: 0, w: width, h: height };
const frame = { x: 10, y: 12, w: 168, h: 193 };
const index = (x: number, y: number) => y * width + x;
function printedGlyphs(variant: string) {
  const ink = new Uint8Array(width * height);
  if (variant === "empty") return ink;
  for (const x of [53, 88, 123])
    for (const y of [62, 102, 142])
      for (let dy = 0; dy < 15; dy++) {
        const length = dy < 3 || dy === 9 ? 11 : 3;
        ink.fill(1, index(x, y + dy), index(x + length, y + dy));
      }
  return ink;
}
function example(variant = "screen") {
  const ink = printedGlyphs(variant);
  const distance = distanceToMask(ink, width, height);
  const source = Buffer.alloc(ink.length * 4, 255);
  for (let i = 0; i < ink.length; i++) {
    const x = i % width,
      y = Math.floor(i / width);
    const inside =
      x >= frame.x &&
      x < frame.x + frame.w &&
      y >= frame.y &&
      y < frame.y + frame.h;
    const dot = (x + 2 * y) % 9 === 0 && variant !== "flat";
    const stock = variant === "gray" ? 128 : 252;
    const shoulder = distance[i] < 6.2 && variant !== "unoutlined";
    const tone =
      (x === 103 && y > 53 && y < 173) || ink[i]
        ? 20
        : inside
          ? dot && !shoulder
            ? 211
            : stock
          : variant === "open"
            ? 200
            : 18;
    source.fill(tone, i * 4, i * 4 + 3);
  }
  const owner = {
    bounds: frame,
    data: new Uint8Array(frame.w * frame.h).fill(1),
  };
  const instance = { bounds, data: ink };
  return { source, instance, owner };
}

describe("Qwen narration box print ownership", () => {
  it("includes the measured clear collar and preserves unprinted dots, pen and frame", () => {
    const { source, instance, owner } = example();
    for (let y = 76; y < 81; y++)
      for (let x = 68; x < 74; x++)
        source.fill(27, 4 * index(x, y), 4 * index(x, y) + 3);
    const measured = measureQwenFramedScreen(
      source,
      { width, height },
      instance,
      owner,
    );
    assert.isDefined(measured);
    const mask = expandWindowMaskToPage(measured, width, height);
    expect(mask[index(49, 66)]).toBe(1);
    expect(mask[index(36, 66)]).toBe(0);
    expect(mask[index(103, 104)]).toBe(0);
    expect(mask[index(102, 104)]).toBe(0);
    expect(mask[index(9, 105)]).toBe(0);
    expect(mask[index(70, 78)]).toBe(0);
  });

  it.each(["flat", "open", "unoutlined", "gray", "empty"])(
    "leaves the normal paper and drawing route in charge of %s material",
    (variant) => {
      const { source, instance, owner } = example(variant);
      expect(
        measureQwenFramedScreen(source, { width, height }, instance, owner),
      ).toBeUndefined();
    },
  );

  it("requires a near-rectangular layout owner of measurable size", () => {
    const { source, instance, owner } = example();
    owner.data.fill(0, 0, owner.data.length / 7);
    expect(
      measureQwenFramedScreen(source, { width, height }, instance, owner),
    ).toBeUndefined();
    expect(
      measureQwenFramedScreen(source, { width, height }, instance, {
        bounds: { ...frame, w: 30 },
        data: owner.data,
      }),
    ).toBeUndefined();
  });
});
