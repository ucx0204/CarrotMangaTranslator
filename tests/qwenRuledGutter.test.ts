import { describe, expect, it } from "vitest";
import { ruledGutterComposite } from "../src/main/inpainting/qwenFramedScreen";
import { expandWindowMaskToPage } from "../src/main/inpainting/inpaintingWindowMask";

describe("Qwen effect crossing a ruled page gutter", () => {
  function scene() {
    const size = { width: 150, height: 120 };
    const bitmap = Buffer.alloc(size.width * size.height * 4, 255);
    const ink = (x: number, y: number, level: number) => {
      const offset = (y * size.width + x) * 4;
      bitmap.fill(level, offset, offset + 3);
    };
    const bounds = { x: 62, y: 35, w: 24, h: 44 };
    const instance = { bounds, data: new Uint8Array(24 * 44) };
    for (let x = 0; x < size.width; x++) {
      for (let y = 23; y < 56; y++) ink(x, y, 189);
      for (let y = 56; y < 60; y++) ink(x, y, 8);
    }
    for (let y = 0; y < bounds.h; y++) {
      for (let x = 0; x < bounds.w; x++) {
        if (x > 5 && x < 19) continue;
        instance.data[y * bounds.w + x] = 1;
        ink(bounds.x + x, bounds.y + y, 0);
      }
    }
    ink(60, 70, 166);
    ink(61, 57, 91);
    ink(62, 57, 228);
    ink(60, 45, 166);
    ink(50, 70, 166);
    return { size, bitmap, ink, instance };
  }
  it("copies a missed antialiased stroke from the native result only on measured outer paper", () => {
    const { size, bitmap, instance } = scene();
    const result = ruledGutterComposite(bitmap, size, instance);
    const full = expandWindowMaskToPage(result, size.width, size.height);
    expect(full[70 * size.width + 60]).toBe(1);
    expect(full[57 * size.width + 61]).toBe(1);
    expect(full[45 * size.width + 60]).toBe(0);
    expect(full[70 * size.width + 50]).toBe(0);
    expect(instance.data.reduce((a, b) => a + b)).toBe(44 * 11);
  });
  it("preserves a photographic or printed bank beside the same selected effect", () => {
    const { size, bitmap, ink, instance } = scene();
    for (let y = 63; y < 94; y++) for (let x = 35; x < 59; x++) ink(x, y, 195);
    expect(ruledGutterComposite(bitmap, size, instance)).toBe(instance);
  });
  it("retains a one-pixel drawn line and refuses to extend a stroke off the page", () => {
    const { size, bitmap, ink, instance } = scene();
    for (let y = 57; y < 60; y++)
      for (let x = 0; x < size.width; x++) ink(x, y, 255);
    expect(ruledGutterComposite(bitmap, size, instance)).toBe(instance);
    const atEdge = { ...instance, bounds: { ...instance.bounds, x: 10 } };
    expect(ruledGutterComposite(bitmap, size, atEdge)).toBe(atEdge);
    const thumbnail = {
      bounds: { x: 75, y: 47, w: 10, h: 8 },
      data: new Uint8Array(80).fill(1),
    };
    expect(ruledGutterComposite(bitmap, size, thumbnail)).toBe(thumbnail);
  });
});
