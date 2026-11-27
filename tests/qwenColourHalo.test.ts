import { assert, expect, it } from "vitest";
import { measuredColouredCaption } from "../src/main/inpainting/qwenCaptionEnvelope";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";
import { dilateBinaryMaskDisk } from "../src/main/inpainting/patternMaskMorphology";

it.each(["white on magenta", "red on white"])(
  "measures the complete native caption and leaves unrelated painted colour alone (%s)",
  (scheme) => {
    const width = 405,
      height = 149,
      bounds = { x: 0, y: 0, w: width, h: height };
    const ink = new Uint8Array(width * height),
      source = Buffer.alloc(4 * ink.length, 255);
    for (let x = 44; x < 365; x += 26)
      for (let y = 58; y < 91; y++)
        ink.fill(1, y * width + x, y * width + x + 7);
    const rim = dilateBinaryMaskDisk(ink, width, height, 11),
      reversed = scheme === "red on white";
    const face = reversed ? [22, 23, 222] : [249, 249, 251];
    const halo = reversed ? [249, 249, 251] : [138, 18, 235];
    for (let i = 0; i < ink.length; i++)
      source.set(ink[i] ? face : rim[i] ? halo : [153, 151, 149], 4 * i);
    source.set(halo, 4 * (12 * width + 174));
    const actual = measuredColouredCaption(
      source,
      { width, height },
      { bounds, data: ink },
    );
    assert.isDefined(actual);
    const matte = expandWindowMaskToPage(actual, width, height);
    expect(matte[54 * width + 48]).toBe(1);
    expect(matte[71 * width + 63]).toBe(1);
    expect(matte[12 * width + 174]).toBe(0);
    for (let i = 0; i < ink.length; i++) if (!ink[i]) source.set(halo, i * 4);
    expect(
      measuredColouredCaption(source, { width, height }, { bounds, data: ink }),
    ).toBeUndefined();
  },
);
