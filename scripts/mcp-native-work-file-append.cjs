const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");
const { checkNativeRasterExports } = require("./mcp-native-raster-export.cjs");
const { checkNativePsdExports } = require("./mcp-native-psd-export.cjs");
const {
  checkNativeWorkFileExport,
} = require("./mcp-native-work-file-export.cjs");
const { sendNativeFile } = require("./mcp-native-incoming-files.cjs");
const { checkNativeExchange } = require("./mcp-native-exchange.cjs");
const { checkNativeOutputSync } = require("./mcp-native-output-sync.cjs");
const { checkNativeComposite } = require("./mcp-native-composite.cjs");
const {
  checkNativeSavedSourceFormats,
} = require("./mcp-native-delivery-source-formats.cjs");

/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} packagePath
 * @param {string} chapterId
 * @param {(client: Client, accepted: {jobId: string}) => Promise<{workFileReceipt?: {id: string, workId: string, chapterIds: string[]}}>} wait */
async function checkNativeWorkFileAppend(
  root,
  app,
  editing,
  packagePath,
  chapterId,
  wait,
) {
  assert.equal(app.appPaths.dataRoot, root, "Never append to a real profile");
  const library = require(join(root, "out/main/library.js"));
  const chapter = await library.openChapter(chapterId);
  const directory = join(library.getLibraryRoot(), "works", chapter.workId);
  const workPath = join(directory, "work.json");
  const beforeWork = JSON.parse(await readFile(workPath, "utf8"));
  const chapterPath = join(directory, "chapters", chapterId, "chapter.json");
  const chapterBytes = await readFile(chapterPath);
  const guidePath = join(directory, "style-guide.json");
  const guide = await optionalBytes(guidePath);
  const packageBytes = await readFile(packagePath);
  const before = await library.listLibrary();
  let client = await retainedClient(root, app, editing);
  try {
    const upload = await sendNativeFile(
      client,
      packageBytes,
      "Append.mgtshare",
    );
    const source = await client.call("preview_work_file", {
      uploadId: upload.uploadId,
    });
    const input = {
      uploadId: upload.uploadId,
      snapshot: source.snapshot,
      chapters: [
        {
          packageChapterId: source.chapters[0].packageChapterId,
          title: chapter.title,
        },
      ],
      target: { workId: chapter.workId, contextPolicy: "preserve-destination" },
    };
    const review = await client.call("preview_work_file_append", input);
    assert.equal(review.eligible, true);
    assert.deepEqual(await library.listLibrary(), before);
    const command = {
      ...input,
      target: review.target,
      requestId: randomUUID(),
      allowNativePreparation: true,
      acknowledgeV1Limitations: true,
    };
    const receipt = (
      await wait(client, await client.call("import_work_file", command))
    ).workFileReceipt;
    assert.ok(receipt);
    assert.equal(receipt.workId, chapter.workId);
    const appended = await library.openChapter(receipt.chapterIds[0]);
    assert.deepEqual(
      appended.pages[0].blocks.map(withoutId),
      chapter.pages[0].blocks.map(withoutId),
    );
    assert.equal(appended.title, review.chapters[0].title);
    assert.deepEqual(
      await readFile(appended.pages[0].imagePath),
      await readFile(chapter.pages[0].imagePath),
    );
    await client.call("discard_file_upload", { uploadId: upload.uploadId });
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
      /packageChapterId|preserve-destination/,
    );
    await client.call("discard_retained", { id: receipt.id, confirm: true });
    const afterWork = JSON.parse(await readFile(workPath, "utf8"));
    assert.deepEqual(afterWork.chapterOrder, [
      ...beforeWork.chapterOrder,
      ...receipt.chapterIds,
    ]);
    assert.equal(
      (await library.listLibrary()).works.length,
      before.works.length,
    );
    assert.deepEqual(await readFile(chapterPath), chapterBytes);
    assert.deepEqual(await optionalBytes(guidePath), guide);
    assert.deepEqual(await readFile(packagePath), packageBytes);
    assert.deepEqual(await library.openChapter(chapterId), chapter);
    console.log(
      "PASS native work-file append -> existing chapters and context preserved -> OS-encrypted receipt -> reconstructed replay without duplication",
    );
  } finally {
    await client.close();
  }
  const rasterOutputs = await checkNativeRasterExports(
    root,
    app,
    editing,
    chapterId,
  );
  await checkNativePsdExports(root, app, editing, chapterId);
  await checkNativeWorkFileExport(root, app, editing, chapterId, wait);
  await checkNativeExchange(root, app, editing, chapterId);
  await checkNativeSavedSourceFormats(root, app, editing, rasterOutputs);
  await checkNativeOutputSync(root, app, editing, chapterId);
  await checkNativeComposite(root, app, editing, packagePath, chapterId);
}
/** @param {string} path */
async function optionalBytes(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
}
/** @param {import("../src/shared/textTypes").TranslationBlock} block */
function withoutId({ id: _id, ...block }) {
  return block;
}
module.exports = { checkNativeWorkFileAppend };
