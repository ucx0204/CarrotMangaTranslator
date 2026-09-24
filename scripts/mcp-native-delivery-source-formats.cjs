const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");
const {
  exportRaster,
  acknowledgeRasterHandoffs,
} = require("./mcp-native-raster-export.cjs");

/** @typedef {import("./mcp-native-exchange-client.cjs").NativeApp} NativeApp */
/** @typedef {import("./mcp-native-exchange-client.cjs").Editing} Editing */
/** @typedef {{bytes:Buffer,mimeType:string}} RenderedSource */

/** Reuse actual files already produced by the earlier native raster fixture. No new renderer driver.
 * Runs after the prior native checks with checkNativeRasterExports' actual saved array.
 * @param {string} root @param {NativeApp} app @param {Editing} editing
 * @param {RenderedSource[]} rasterOutputs */
async function checkNativeSavedSourceFormats(
  root,
  app,
  editing,
  rasterOutputs,
) {
  assert.equal(app.appPaths.dataRoot, root);
  const library = require(join(root, "out/main/library.js"));
  const { probeImageBuffer } = require(
    join(root, "out/main/libraryStore/imageHeaderProbe.js"),
  );
  const imported = await importSavedRasterSources(root, rasterOutputs);
  const chapter = imported.chapter;
  const originals = await Promise.all(
    chapter.pages.map(
      async (
        /** @type {import("../src/shared/libraryTypes").MangaPage} */ page,
      ) => ({
        path: page.imagePath,
        bytes: await readFile(page.imagePath),
      }),
    ),
  );
  const client = await retainedClient(root, app, editing);
  const stopHandoffs = acknowledgeRasterHandoffs(app.jobs.pageHandoffs);
  const options = {
    format: "source",
    omitText: false,
    jpegQuality: 72,
    webpQuality: 83,
    unsupportedSource: "reject",
  };
  /** @type {{format:string, pageId:string, identicalBytes:boolean}[]} */
  const comparisons = [];
  try {
    const selected = chapter.pages.slice(0, 3);
    const review = await client.call("preflight_pages_export", {
      chapterId: chapter.id,
      pageIds: selected
        .map((/** @type {{id:string}} */ page) => page.id)
        .reverse(),
      imageExport: options,
    });
    assert.equal(review.pages.length, 3);
    assert.deepEqual(
      review.pages.map((/** @type {{pageId:string}} */ page) => page.pageId),
      selected.map((/** @type {{id:string}} */ page) => page.id),
    );
    assert.deepEqual(
      review.pages.map(
        (/** @type {{imageExport:{format:string}}} */ page) =>
          page.imageExport.format,
      ),
      ["png", "jpeg", "webp"],
    );
    for (const page of review.pages) {
      assert.equal(page.sourceFormatBasis, "saved-source-name");
      assert.equal(page.fallback, "none");
      const source = await exportRaster(
        client,
        chapter.id,
        page.pageId,
        options,
      );
      const concrete = await exportRaster(
        client,
        chapter.id,
        page.pageId,
        page.imageExport,
      );
      assert.equal(
        probeImageBuffer(source.bytes, source.filename).format,
        page.imageExport.format,
      );
      assert.equal(source.mimeType, concrete.mimeType);
      assert.ok(
        source.bytes.equals(concrete.bytes),
        "Source policy must select the same native encoder and quality",
      );
      const job = await client.call("get_job", { jobId: source.jobId });
      const saved = job.result.exportPages.pages[0];
      assert.equal(saved.sourceFormatBasis, "saved-source-name");
      assert.deepEqual(saved.imageExport, page.imageExport);
      await client.call("discard_retained", { id: source.id, confirm: true });
      await client.call("discard_retained", { id: concrete.id, confirm: true });
      comparisons.push({
        format: page.imageExport.format,
        pageId: page.pageId,
        identicalBytes: true,
      });
    }
    assert.equal(comparisons.length, 3);
    assert.deepEqual(await library.openChapter(chapter.id), chapter);
    for (const original of originals)
      assert.ok((await readFile(original.path)).equals(original.bytes));
    for (const original of imported.inputs)
      assert.ok((await readFile(original.path)).equals(original.bytes));
    console.log(
      "PASS native saved-source export -> actual PNG JPEG WebP sources -> three byte-identical concrete encoder comparisons; selected pages and originals preserved",
    );
    return {
      comparedFormats: comparisons,
      importedFormats: imported.formats,
      selectedPages: 3,
      unselectedPages: 1,
      originalsPreserved: true,
      providedSourcesPreserved: true,
    };
  } finally {
    stopHandoffs();
    await client.close();
  }
}

/** Native import freezes real encoded source files in a separate fixture work.
 * @param {string} root @param {RenderedSource[]} outputs */
async function importSavedRasterSources(root, outputs) {
  const library = require(join(root, "out/main/library.js"));
  const { probeImageBuffer } = require(
    join(root, "out/main/libraryStore/imageHeaderProbe.js"),
  );
  const inputRoot = join(root, "native-exchange-source-codecs");
  await mkdir(inputRoot, { recursive: true });
  const formats = [
    { mimeType: "image/png", name: "saved-original.png" },
    { mimeType: "image/jpeg", name: "saved-original.jpeg" },
    { mimeType: "image/webp", name: "saved-original.webp" },
  ];
  /** @type {{name:string,sourcePath:string,sourceKind:string}[]} */
  const pages = [];
  /** @type {{path:string,bytes:Buffer}[]} */
  const inputs = [];
  for (const format of formats) {
    const output = outputs.find((item) => item.mimeType === format.mimeType);
    assert.ok(output, `Missing actual prior native ${format.mimeType} output`);
    const sourcePath = join(inputRoot, format.name);
    await writeFile(sourcePath, output.bytes, { flag: "wx" });
    inputs.push({ path: sourcePath, bytes: output.bytes });
    pages.push({ name: format.name, sourcePath, sourceKind: "file" });
  }
  pages.push({ ...pages[0], name: "unselected-original.png" });
  const draftId = randomUUID();
  const imported = await library.createImport({
    preview: {
      mode: "batch",
      sourceKind: "images",
      suggestedWorkTitle: "Native saved-source format fixture",
      chapters: [
        { draftId, title: "Native saved formats", sourceKind: "images", pages },
      ],
    },
    target: { mode: "new", title: "Native saved-source format fixture" },
    selections: [{ draftId, title: "Native saved formats", enabled: true }],
  });
  const chapter = await library.openChapter(imported.chapterIds[0]);
  assert.equal(chapter.pages.length, 4);
  /** @type {{pageId:string,sourceFormat:string,savedFormat:string}[]} */
  const importedFormats = [];
  for (const [index, page] of chapter.pages.entries()) {
    const original = await readFile(pages[index].sourcePath);
    const saved = await readFile(page.imagePath);
    const source = probeImageBuffer(original, pages[index].name);
    const native = probeImageBuffer(saved, page.name);
    assert.equal(native.width, source.width);
    assert.equal(native.height, source.height);
    assert.equal(page.name, pages[index].name);
    if (source.format === "webp")
      assert.equal(
        native.format,
        "png",
        "Native import normalizes WebP working originals to PNG while preserving the saved source name",
      );
    else assert.ok(saved.equals(original));
    importedFormats.push({
      pageId: page.id,
      sourceFormat: source.format,
      savedFormat: native.format,
    });
  }
  return { chapter, inputs, formats: importedFormats };
}
module.exports = { checkNativeSavedSourceFormats };
