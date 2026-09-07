import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regionReferenceImages } from "../src/main/pipeline/codexTypesettingRaster";
import type { PipelineRegionContext } from "../src/main/pipeline/types";
const decode = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ nativeImage: { createFromBuffer: decode } }));

it("provides the original full page with crop coordinates, bounds resolution and rejects damaged references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "region-reference-"));
  try {
    const imagePath = join(directory, "source.png");
    await writeFile(imagePath, "pixels");
    const context: PipelineRegionContext = {
      sourcePage: {
        id: "source",
        name: "original",
        imagePath,
        dataUrl: "",
        width: 2000,
        height: 4000,
        blocks: [],
        analysisStatus: "idle",
        createdAt: "",
        updatedAt: "",
      },
      sourcePageIndex: 1,
      cropRect: { x: 300, y: 0, w: 327, h: 271 },
    };
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 2000, height: 4000 }),
      resize: vi.fn(() => ({ toDataURL: () => "resized" })),
      toDataURL: () => "native",
    };
    decode.mockReturnValue(image);
    expect(await regionReferenceImages(undefined)).toEqual([]);
    expect(await regionReferenceImages(context)).toEqual([
      {
        label: expect.stringContaining(
          'selected crop in original-page pixels={"x":300,"y":0,"w":327,"h":271}',
        ),
        dataUrl: "resized",
      },
    ]);
    expect(image.resize).toHaveBeenCalledWith({
      width: 800,
      height: 1600,
      quality: "best",
    });
    image.getSize = () => ({ width: 500, height: 1000 });
    context.sourcePage.width = 500;
    context.sourcePage.height = 1000;
    expect((await regionReferenceImages(context))[0].dataUrl).toBe("native");
    context.sourcePage.width = 600;
    await expect(regionReferenceImages(context)).rejects.toThrow(/크기/);
    image.isEmpty = () => true;
    await expect(regionReferenceImages(context)).rejects.toThrow(/읽지/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
