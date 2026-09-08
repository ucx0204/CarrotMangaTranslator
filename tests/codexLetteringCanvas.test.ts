import { expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { prepareCodexLetteringCanvas } from "../src/main/pipeline/codexLetteringCanvas";
vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => ({
      isEmpty: () => bytes.length === 0,
      resize: (size: { width: number; height: number }) => {
        const source = PNG.sync.read(bytes);
        expect(size).toMatchObject({
          width: source.width,
          height: source.height,
        });
        return { toPNG: () => bytes };
      },
    }),
  },
}));
it("leaves normal canvases and their mapping untouched", () => {
  const reference = { label: "reference", dataUrl: "unchanged" },
    size = { w: 240, h: 120 },
    box = { x: 100, y: 200, w: 240, h: 120 };
  const result = prepareCodexLetteringCanvas(
    reference,
    size,
    box,
    { width: 1000, height: 1000 },
    "#00ff00",
  );
  expect(result).toEqual({ reference, size, renderBbox: box });
  expect(result.reference).toBe(reference);
});
it.each([
  [1200, 100],
  [100, 1200],
])(
  "plans foreground room before generation while retaining every source pixel and its destination (%s x %s)",
  (w, h) => {
    const source = new PNG({ width: w, height: h });
    source.data.fill(255);
    const reference = {
      label: "source",
      dataUrl: `data:image/png;base64,${PNG.sync.write(source).toString("base64")}`,
    };
    const page = { width: 2000, height: 2000 },
      box = { x: 100, y: 300, w: w / 2, h: h / 2 };
    const result = prepareCodexLetteringCanvas(
      reference,
      { w, h },
      box,
      page,
      "#00ff00",
    );
    const png = PNG.sync.read(
      Buffer.from(result.reference.dataUrl.split(",")[1], "base64"),
    );
    expect(
      Math.max(png.width, png.height) / Math.min(png.width, png.height),
    ).toBeLessThanOrEqual(3);
    const left = Math.floor((png.width - w) / 2),
      top = Math.floor((png.height - h) / 2);
    expect(result.renderBbox.x + left / 2).toBe(box.x);
    expect(result.renderBbox.y + top / 2).toBe(box.y);
    expect([...png.data.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    for (let y = 0; y < h; y++)
      expect(
        png.data.subarray(
          ((y + top) * png.width + left) * 4,
          ((y + top) * png.width + left + w) * 4,
        ),
      ).toEqual(source.data.subarray(y * w * 4, (y + 1) * w * 4));
  },
);
