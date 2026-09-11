import { afterEach, expect, it, vi } from "vitest";
import { renderRedactionMaskSurface } from "../src/renderer/src/components/imageRedaction/redactionMaskSurface";
import type { ImageRedactionStroke } from "../src/shared/imageRedaction";

afterEach(() => vi.unstubAllGlobals());

function canvasBoundary() {
  const allocations: number[] = [];
  const createImageData = (width: number, height: number) => {
    allocations.push(width * height);
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  };
  const context = {
    createImageData,
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
  };
  vi.stubGlobal("document", {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
    setTimeout(callback, 0),
  );
  return { allocations, context };
}
const first: ImageRedactionStroke = {
  shape: "rectangle",
  size: 1,
  points: [
    { x: 32, y: 32 },
    { x: 48, y: 48 },
  ],
};

it("keeps a long-page overview small and repaints only an appended stroke's native bounds", async () => {
  const { allocations } = canvasBoundary();
  const page = { width: 3000, height: 10000 };
  const window = { x: 0, y: 0, ...page, factor: 8 };
  const signal = new AbortController().signal;
  const before = await renderRedactionMaskSurface(
    page,
    window,
    [first],
    signal,
  );
  expect(before.canvas.width * before.canvas.height).toBe(468750);
  expect(allocations).toEqual([256]);
  allocations.length = 0;
  await renderRedactionMaskSurface(
    page,
    window,
    [
      first,
      {
        ...first,
        operation: "restore",
        points: [
          { x: 40, y: 40 },
          { x: 48, y: 48 },
        ],
      },
    ],
    signal,
    before,
  );
  expect(allocations).toEqual([64]);
});

it("does not publish a cancelled surface or mutate the previous committed canvas", async () => {
  canvasBoundary();
  const page = { width: 100, height: 100 };
  const window = { x: 0, y: 0, ...page, factor: 1 };
  const signal = new AbortController().signal;
  const before = await renderRedactionMaskSurface(
    page,
    window,
    [first],
    signal,
  );
  const controller = new AbortController();
  controller.abort(new Error("page changed"));
  await expect(
    renderRedactionMaskSurface(page, window, [], controller.signal, before),
  ).rejects.toThrow("page changed");
  expect(before.strokes).toEqual([first]);
  expect(before.canvas.width).toBe(100);
});
