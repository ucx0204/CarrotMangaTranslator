const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { initializeCanvas, readPsd } = require("ag-psd");
const { PNG } = require("pngjs");
const { retainedClient } = require("./mcp-native-retention.cjs");
const {
  exportRaster,
  checkZip,
  readArtifact,
  acknowledgeRasterHandoffs,
} = require("./mcp-native-raster-export.cjs");

/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} chapterId */
async function checkNativePsdExports(root, app, editing, chapterId) {
  assert.equal(root, app.appPaths.dataRoot, "Use only the isolated profile");
  const library = require(join(root, "out/main/library.js"));
  const chapter = await library.openChapter(chapterId);
  const page = chapter.pages[0];
  assert.ok(
    page.inpaintedImagePath,
    "Raster fixture must prepare its background first",
  );
  const chapterPath = join(
    library.getLibraryRoot(),
    "works",
    chapter.workId,
    "chapters",
    chapterId,
    "chapter.json",
  );
  const chapterBytes = await readFile(chapterPath);
  const original = await readFile(page.imagePath);
  const cleaned = await readFile(page.inpaintedImagePath);
  let client = await retainedClient(root, app, editing);
  const stopHandoffs = acknowledgeRasterHandoffs(app.jobs.pageHandoffs);
  try {
    const options = {
      format: "psd",
      omitText: false,
      acknowledgeOriginalLayer: true,
      acknowledgeRasterLayers: true,
    };
    const result = await exportRaster(client, chapterId, page.id, options);
    assert.equal(result.mimeType, "image/vnd.adobe.photoshop");
    assert.ok(result.filename.endsWith(".psd"));
    const raster = await exportRaster(client, chapterId, page.id, {
      format: "png",
      omitText: false,
    });
    verifyPsdPixels(result.bytes, original, cleaned, raster.bytes, page);
    const zip = await checkZip(client, result, options);
    await client.close();
    client = await retainedClient(root, app, editing);
    for (const output of [result, raster, zip]) {
      const file = await client.call("get_output_file", { id: output.id });
      assert.equal(file.mimeType, output.mimeType);
      assert.deepEqual(await readArtifact(client, file.url), output.bytes);
      await client.call("discard_retained", { id: output.id, confirm: true });
      await assert.rejects(() => readArtifact(client, file.url));
    }
    assert.deepEqual(await readFile(chapterPath), chapterBytes);
    assert.deepEqual(await library.openChapter(chapterId), chapter);
    assert.deepEqual(await readFile(page.imagePath), original);
    assert.deepEqual(await readFile(page.inpaintedImagePath), cleaned);
    console.log(
      "PASS native PSD export -> native layers and original pixels -> ZIP -> reconstructed retained bytes",
    );
  } finally {
    stopHandoffs();
    await client.close();
  }
}

/** @param {Buffer} bytes @param {Buffer} original @param {Buffer} cleaned
 * @param {Buffer} composite @param {import("../src/shared/libraryTypes").MangaPage} page */
function verifyPsdPixels(bytes, original, cleaned, composite, page) {
  initializeCanvas(
    () => {
      throw new Error("PSD pixel validation must not require a canvas");
    },
    (width, height) => ({
      width,
      height,
      colorSpace: "srgb",
      data: new Uint8ClampedArray(width * height * 4),
    }),
  );
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
  assert.deepEqual([psd.width, psd.height], [page.width, page.height]);
  const layers = psd.children;
  assert.ok(layers && layers.length === page.blocks.length + 2);
  assert.equal(layers[0].name, "원본 배경 (Original)");
  assert.equal(layers[1].name, "정리 배경 (Inpaint)");
  assert.ok(layers[0].imageData && layers[1].imageData && psd.imageData);
  assert.deepEqual(
    Buffer.from(layers[0].imageData.data),
    PNG.sync.read(original).data,
  );
  assert.deepEqual(
    Buffer.from(layers[1].imageData.data),
    PNG.sync.read(cleaned).data,
  );
  assert.deepEqual(
    Buffer.from(psd.imageData.data),
    PNG.sync.read(composite).data,
  );
  assert.ok(layers.slice(2).some((layer) => layer.text?.text));
  for (const layer of layers.slice(2)) {
    assert.ok(
      layer.imageData?.data.some(
        (value, index) => index % 4 === 3 && value > 0,
      ),
    );
  }
}
module.exports = { checkNativePsdExports };
