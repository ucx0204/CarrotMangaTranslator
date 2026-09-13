import { writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
import { editingChapter } from "./mcpEditing.fixture";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";

async function fixture() {
  const page = editingChapter().pages[0];
  const png = PNG.sync.write(
    new PNG({ width: page.width, height: page.height }),
  );
  const encode = vi.fn(() => png);
  const image = {
    getSize: () => ({ width: page.width, height: page.height }),
    isEmpty: () => false,
    toPNG: encode,
    crop: () => image,
    resize: () => image,
  };
  const environment = await mcpAppEnvironment({ createFromPath: () => image });
  page.imagePath = join(environment.root, "original.png");
  page.inpaintedImagePath = join(environment.root, "clean.png");
  await writeFile(page.imagePath, png);
  await writeFile(page.inpaintedImagePath, png);
  const adapter = await import("../src/main/mcp/mcpPageImageAdapter");
  const preview = await import("../src/main/mcp/mcpPreviewImage");
  const setProtection = (enabled: boolean) =>
    writeFileSync(
      join(environment.root, "image-redactions.json"),
      JSON.stringify({ enabled, pages: {} }),
    );
  const renderPage = vi.fn(async () => png);
  const close = vi.fn();
  const openRenderer = vi.fn(async () => ({ renderPage, close }));
  return {
    ...environment,
    page,
    png,
    encode,
    setProtection,
    adapter,
    preview,
    renderPage,
    openRenderer,
    rendererClosed: close,
  };
}

it.each(["crop", "source"])(
  "rechecks the real review store before disclosing a %s encoded after protection is enabled",
  async (kind) => {
    const f = await fixture();
    try {
      f.encode.mockImplementationOnce(() => {
        f.setProtection(true);
        return f.png;
      });
      await expect(
        kind === "crop"
          ? f.adapter.cropMcpPage(f.page, { x: 0, y: 0, w: 20, h: 20 })
          : f.preview.renderMcpPagePreview(f.page),
      ).rejects.toThrow("가릴 페이지");
    } finally {
      await f.close();
    }
  },
);

it("does not return a derived PNG when protection changes while the renderer works", async () => {
  const f = await fixture();
  try {
    f.renderPage.mockImplementationOnce(async () => {
      f.setProtection(true);
      return f.png;
    });
    await expect(
      f.adapter.renderMcpPagePng(f.page, undefined, 1000, f.openRenderer),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(f.rendererClosed).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("keeps original-resolution rendering and closes its native session on success", async () => {
  const f = await fixture();
  try {
    await expect(
      f.adapter.renderMcpPagePng(f.page, undefined, 1000, f.openRenderer),
    ).resolves.toEqual(f.png);
    expect(f.renderPage).toHaveBeenCalledWith(
      { ...f.page, imagePath: f.page.inpaintedImagePath },
      { format: "png", resolutionMode: "original" },
    );
    expect(f.rendererClosed).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
