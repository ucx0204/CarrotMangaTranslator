const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");
const { importEditableWorkFile } = require("./mcp-native-work-file-import.cjs");
const {
  checkNativeWorkFileAppend,
} = require("./mcp-native-work-file-append.cjs");

/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** @typedef {{id: string, workId: string, chapterIds: string[]}} Receipt */
/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} sourceChapterId
 * @param {(client: Client, accepted: {jobId: string}) => Promise<{workFileReceipt?: Receipt}>} wait */
async function checkNativeWorkFile(root, app, editing, sourceChapterId, wait) {
  assert.equal(app.appPaths.dataRoot, root, "Never modify a real profile");
  const library = require(join(root, "out/main/library.js"));
  const source = await prepareEditableSource(library, sourceChapterId);
  const packagePath = join(root, "native-working-file.mgtshare");
  await library.exportWorkShareToFile({
    workId: source.workId,
    chapterIds: [sourceChapterId],
    outputPath: packagePath,
  });
  const bytes = await readFile(packagePath);
  const before = await library.listLibrary();
  let client = await retainedClient(root, app, editing);
  try {
    const { command, receipt, page } = await importEditableWorkFile(
      client,
      library,
      bytes,
      source,
      wait,
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    assert.deepEqual(
      await client.call("get_work_file_import", {
        requestId: command.requestId,
      }),
      receipt,
    );
    assert.deepEqual(
      (await wait(client, await client.call("import_work_file", command)))
        .workFileReceipt,
      receipt,
    );
    await client.call("discard_retained", { id: receipt.id, confirm: true });
    assert.equal(
      (await library.listLibrary()).works.length,
      before.works.length + 1,
    );
    assert.deepEqual(await readFile(packagePath), bytes);
    assert.deepEqual(await library.openChapter(sourceChapterId), source);
    assert.deepEqual(
      (await library.openChapter(receipt.chapterIds[0])).pages[0].blocks,
      page.blocks,
    );
    console.log(
      "PASS native working file -> native share export and byte upload -> editable import and OS-encrypted receipt -> reconstructed replay -> original preservation",
    );
  } finally {
    await client.close();
  }
  await checkNativeWorkFileAppend(
    root,
    app,
    editing,
    packagePath,
    sourceChapterId,
    wait,
  );
}
/** @param {typeof import("../src/main/library")} library @param {string} chapterId */
async function prepareEditableSource(library, chapterId) {
  const chapter = await library.openChapter(chapterId);
  await library.savePageBlocks({
    chapterId,
    pageId: chapter.pages[0].id,
    blocks: [editableBlock("first", 0), editableBlock("second", 500)],
    blockOrder: ["second", "first"],
  });
  return library.openChapter(chapterId);
}
/** @param {string} id @param {number} x
 * @returns {import("../src/shared/textTypes").TranslationBlock} */
function editableBlock(id, x) {
  return {
    id,
    type: "nonsolid",
    bbox: { x, y: 0, w: 400, h: 500 },
    sourceText: "Native source",
    translatedText: "Editable translation",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 12,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}
module.exports = { checkNativeWorkFile };
