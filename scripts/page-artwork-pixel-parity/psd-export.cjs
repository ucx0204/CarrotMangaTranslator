// @ts-check
const assert = require("node:assert/strict");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { initializeCanvas, readPsd } = require("ag-psd");
const { PNG } = require("pngjs");

/**
 * Exercise the compiled production session/PSD runner together in Electron.
 * @param {{root: string; artifactDir: string; session: import("../../src/main/pageExport").PageExportRenderSession; page: {width: number; height: number; imagePath: string; blocks: Array<{id: string}>}}} input
 */
async function verifyPsdExport({ root, artifactDir, session, page }) {
  const { writePagePsdExport } = require(
    join(root, "out", "main", "jobs", "pagePsdExportRunner.js"),
  );
  const outputPath = join(artifactDir, "session-layered-export.psd");
  await writePagePsdExport({
    abortController: new AbortController(),
    completedPages: 0,
    dependencies: { runtime: { writePsd: writeFile } },
    omitText: false,
    outputPath,
    page: {
      ...page,
      blocks: page.blocks.slice(0, 3),
      inpaintedImagePath: page.imagePath,
    },
    renderSession: session,
    throwIfAborted: (/** @type {AbortController} */ controller) =>
      controller.signal.throwIfAborted(),
    totalPages: 1,
  });
  initializeCanvas(
    () => {
      throw new Error("PSD pixel verification must not require a canvas.");
    },
    (width, height) => ({
      width,
      height,
      colorSpace: "srgb",
      data: new Uint8ClampedArray(width * height * 4),
    }),
  );
  const psd = readPsd(await readFile(outputPath), { useImageData: true });
  assert.deepEqual([psd.width, psd.height], [page.width, page.height]);
  assert.equal(
    psd.children?.length,
    5,
    "PSD must contain both backgrounds and three rendered layers",
  );
  assert.deepEqual(
    psd.children?.slice(0, 2).map((layer) => layer.name),
    ["원본 배경 (Original)", "정리 배경 (Inpaint)"],
  );
  for (const layer of psd.children?.slice(2) ?? []) {
    const pixels = layer.imageData?.data;
    assert.ok(
      pixels?.some((value, index) => index % 4 === 3 && value > 0),
      "Text layer must contain visible pixels",
    );
    assert.ok(
      pixels?.some((value, index) => index % 4 === 3 && value < 255),
      "Text layer must retain transparency",
    );
  }
  const composite = psd.imageData;
  assert.ok(composite, "PSD must contain a merged preview");
  const previewPath = join(artifactDir, "session-layered-export.png");
  const preview = new PNG({ width: psd.width, height: psd.height });
  preview.data = Buffer.from(composite.data);
  await writeFile(previewPath, PNG.sync.write(preview));
  return { outputPath, previewPath, layers: psd.children?.length };
}

module.exports = { verifyPsdExport };
