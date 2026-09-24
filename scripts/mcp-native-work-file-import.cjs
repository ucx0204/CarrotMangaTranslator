const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { sendNativeFile } = require("./mcp-native-incoming-files.cjs");

/** @typedef {Awaited<ReturnType<typeof import("./mcp-native-retention.cjs").retainedClient>>} Client */
/** @typedef {{id: string, workId: string, chapterIds: string[]}} Receipt */
/** @typedef {(client: Client, accepted: {jobId: string}) => Promise<{workFileReceipt?: Receipt}>} Wait */

/** The original incoming-file smoke and public export roundtrip use the same native import.
 * @param {Client} client @param {typeof import("../src/main/library")} library
 * @param {Buffer} bytes @param {import("../src/shared/libraryTypes").ChapterSnapshot} source
 * @param {Wait} wait */
async function importEditableWorkFile(client, library, bytes, source, wait) {
  const before = await library.listLibrary();
  const uploaded = await sendNativeFile(client, bytes, "Editable.mgtshare");
  const review = await client.call("preview_work_file", {
    uploadId: uploaded.uploadId,
  });
  assert.equal(review.retention, "requires-live-upload");
  const selected = review.chapters.find(
    (/** @type {{packageChapterId: string}} */ chapter) =>
      chapter.packageChapterId === source.id,
  );
  assert.ok(selected);
  assert.equal(selected.blockCount, 2);
  assert.deepEqual(await library.listLibrary(), before);
  const command = {
    requestId: randomUUID(),
    uploadId: uploaded.uploadId,
    snapshot: review.snapshot,
    target: { mode: "new", title: "Native editable copy" },
    chapters: [
      { packageChapterId: selected.packageChapterId, title: "Copied chapter" },
    ],
    allowNativePreparation: true,
    acknowledgeV1Limitations: true,
  };
  const result = await wait(
    client,
    await client.call("import_work_file", command),
  );
  const receipt = result.workFileReceipt;
  assert.ok(receipt);
  const page = await assertEditableImport(library, receipt, source);
  assert.equal(
    (await library.listLibrary()).works.length,
    before.works.length + 1,
  );
  await client.call("discard_file_upload", { uploadId: uploaded.uploadId });
  return { command, receipt, page };
}

/** @param {typeof import("../src/main/library")} library
 * @param {Receipt} receipt
 * @param {import("../src/shared/libraryTypes").ChapterSnapshot} source */
async function assertEditableImport(library, receipt, source) {
  const imported = await library.openChapter(receipt.chapterIds[0]);
  const page = imported.pages[0];
  assert.notEqual(page.id, source.pages[0].id);
  assert.deepEqual(
    page.blockOrder,
    page.blocks.map((block) => block.id).reverse(),
  );
  assert.deepEqual(
    page.blocks.map(withoutId),
    source.pages[0].blocks.map(withoutId),
  );
  assert.ok(
    (await readFile(page.imagePath)).equals(
      await readFile(source.pages[0].imagePath),
    ),
    "Imported original image bytes must match",
  );
  if (source.pages[0].inpaintedImagePath) {
    assert.ok(page.inpaintedImagePath);
    assert.ok(
      (await readFile(page.inpaintedImagePath)).equals(
        await readFile(source.pages[0].inpaintedImagePath),
      ),
      "Imported processed image bytes must match",
    );
  }
  assert.doesNotMatch(
    await readFile(
      join(
        library.getLibraryRoot(),
        ".mcp-retained",
        receipt.id,
        "record.json",
      ),
      "utf8",
    ),
    /Native editable copy|packageChapterId/,
  );
  return page;
}

/** @param {import("../src/shared/textTypes").TranslationBlock} block */
function withoutId({ id: _id, ...block }) {
  return block;
}
module.exports = { importEditableWorkFile };
