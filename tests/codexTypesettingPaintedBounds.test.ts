import { describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { measureCodexPaintedBounds } from "../src/main/pipeline/codexTypesettingRaster";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { PageExportRenderSession } from "../src/main/pageExport";

vi.mock("electron", () => ({ nativeImage: {} }));
const page: MangaPage = {
  id: "p",
  name: "synthetic",
  width: 10,
  height: 8,
  imagePath: "source.png",
  dataUrl: "",
  analysisStatus: "completed",
  createdAt: "",
  updatedAt: "",
  blocks: ["painted", "empty"].map((id) => ({
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    sourceText: "source",
    translatedText: "target",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 12,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 0,
  })),
};

function fixture() {
  const image = new PNG({ width: 10, height: 8 });
  image.data.fill(0);
  const empty = PNG.sync.write(image);
  image.data[(2 * 10 + 1) * 4 + 3] = 1;
  image.data[(6 * 10 + 8) * 4 + 3] = 255;
  const painted = PNG.sync.write(image);
  const render: PageExportRenderSession = {
    close: vi.fn(),
    renderPage: vi.fn(async () => empty),
    renderTransparentPage: vi.fn(async (next) =>
      next.blocks[0].id === "painted" ? painted : empty,
    ),
  };
  return { render, empty, painted };
}

describe("native production foreground coverage", () => {
  it("measures every nonzero alpha pixel independently, distinguishing an empty layer", async () => {
    const { render } = fixture();
    const original = structuredClone(page);
    const result = await measureCodexPaintedBounds(
      page,
      render,
      new AbortController().signal,
    );
    expect(result.get("painted")).toEqual({ x: 100, y: 250, w: 800, h: 625 });
    expect(result.get("empty")).toBeNull();
    expect(render.renderTransparentPage).toHaveBeenCalledTimes(2);
    expect(render.renderTransparentPage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [page.blocks[0]],
        blockOrder: ["painted"],
      }),
      { format: "png", resolutionMode: "original" },
    );
    expect(render.renderPage).not.toHaveBeenCalled();
    expect(page).toEqual(original);
  });

  it("refuses unavailable or rescaled coverage instead of accepting missing evidence", async () => {
    const { render } = fixture();
    const controller = new AbortController();
    await expect(
      measureCodexPaintedBounds(
        page,
        { ...render, renderTransparentPage: undefined },
        controller.signal,
      ),
    ).rejects.toThrow(/렌더러/);
    render.renderTransparentPage = vi.fn(async () =>
      PNG.sync.write(new PNG({ width: 9, height: 8 })),
    );
    await expect(
      measureCodexPaintedBounds(page, render, controller.signal),
    ).rejects.toThrow(/해상도/);
  });

  it("propagates capture errors and cancellation before or after a capture", async () => {
    const { render } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      measureCodexPaintedBounds(page, render, controller.signal),
    ).rejects.toThrow();
    expect(render.renderTransparentPage).not.toHaveBeenCalled();
    render.renderTransparentPage = vi.fn(async () => {
      throw new Error("capture failed");
    });
    await expect(
      measureCodexPaintedBounds(page, render, new AbortController().signal),
    ).rejects.toThrow("capture failed");
    const late = new AbortController();
    render.renderTransparentPage = vi.fn(async () => {
      late.abort();
      return Buffer.from("not a raster");
    });
    await expect(
      measureCodexPaintedBounds(page, render, late.signal),
    ).rejects.toThrow();
  });
});
