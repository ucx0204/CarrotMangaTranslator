import { initializeCanvas, readPsd } from "ag-psd";
import { PNG } from "pngjs";
import { vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type { PageExportCaptureOptions } from "../src/main/pageExportCapture";
import { McpPsdExportOptionsSchema } from "../src/shared/mcpOutputFormats";
import { exportFixture } from "./mcpExportBatch.fixture";
import { renderMcpPsdInSession } from "../src/main/mcp/mcpPsdExport";

export const psdOptions = McpPsdExportOptionsSchema.parse({
  format: "psd",
  acknowledgeOriginalLayer: true,
  acknowledgeRasterLayers: true,
});

/** Native parser still decodes every byte; only the canvas allocation boundary is supplied. */
export function readPsdPixels(bytes: Buffer) {
  initializeCanvas(
    () => {
      throw new Error("Pixel-only PSD verification must not need a canvas.");
    },
    (width, height) => ({
      width,
      height,
      colorSpace: "srgb",
      data: new Uint8ClampedArray(width * height * 4),
    }),
  );
  return readPsd(bytes, { useImageData: true, skipThumbnail: true });
}

export function psdCaptureFixture(page: MangaPage) {
  const png = (shade: number, transparent = false) => {
    const image = new PNG({ width: page.width, height: page.height });
    if (transparent) image.data.set([shade, shade, shade, 255], 4);
    else {
      for (let index = 0; index < image.data.length; index += 4)
        image.data.set([shade, shade, shade, 255], index);
    }
    return PNG.sync.write(image);
  };
  const original = png(30);
  const cleaned = png(240);
  const composite = png(150);
  const text = png(10, true);
  const session = {
    renderPage: vi.fn(
      async (layer: MangaPage, _capture?: PageExportCaptureOptions) =>
        layer.blocks.length
          ? composite
          : layer.inpaintedImagePath
            ? cleaned
            : original,
    ),
    renderTransparentPage: vi.fn(
      async (_layer: MangaPage, _capture?: PageExportCaptureOptions) => text,
    ),
    close: vi.fn(),
    cancel: vi.fn(),
  };
  return { session, original, cleaned, composite, text };
}

export function psdExportFixture() {
  const f = exportFixture();
  for (const page of f.chapter.pages) {
    page.width = 8;
    page.height = 8;
    page.inpaintedImagePath = "fixture-cleaned.png";
    page.blocks = page.blocks.map((block, index) => ({
      ...block,
      translatedText: `PSD text ${index + 1}`,
      renderDirection: index === 0 ? "horizontal" : "vertical",
    }));
  }
  const capture = psdCaptureFixture(f.chapter.pages[0]);
  f.renderImage.mockImplementation(async (page, signal) =>
    Buffer.from(await renderMcpPsdInSession(page, capture.session, signal)),
  );
  return { ...f, capture };
}
