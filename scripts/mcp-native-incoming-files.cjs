const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");

/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** Reuses the parent's job wait function and owns only an isolated native fixture.
 * @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {Buffer} bytes
 * @param {(client: Client, accepted: {jobId: string}) => Promise<{importPreview?: {previewId: string, snapshot: string}, importReceipt?: {id: string, workId: string, chapterIds: string[]}}>} wait */
async function checkNativeIncomingFiles(root, app, editing, bytes, wait) {
  assert.equal(app.appPaths.dataRoot, root);
  const library = require(join(root, "out/main/library.js"));
  const before = await library.listLibrary();
  let client = await retainedClient(root, app, editing);
  try {
    const upload = await sendNativeFile(client, bytes, "Native incoming.png");
    const ready = upload;
    assert.equal(ready.validation, "bytes-verified");
    assert.equal(ready.importable, "not-yet-checked");
    assert.deepEqual(await library.listLibrary(), before);
    const prepared = await wait(
      client,
      await client.call("prepare_uploaded_import", {
        requestId: randomUUID(),
        source: "local",
        uploadId: upload.uploadId,
        kind: "images",
      }),
    );
    const ref = prepared.importPreview;
    assert.ok(ref);
    const review = await client.call("get_import_preview", {
      previewId: ref.previewId,
      snapshot: ref.snapshot,
    });
    assert.equal(review.pages[0].name, "Native incoming.png");
    await client.call("discard_file_upload", { uploadId: upload.uploadId });
    const input = {
      requestId: randomUUID(),
      previewId: ref.previewId,
      snapshot: ref.snapshot,
      allowNativePreparation: true,
      target: { mode: "new", title: "Native incoming work" },
      chapters: [
        {
          draftId: review.pages[0].draftId,
          title: "Incoming chapter",
          pageIds: [review.pages[0].pageId],
        },
      ],
    };
    const imported = await wait(
      client,
      await client.call("import_chapters", input),
    );
    const receipt = imported.importReceipt;
    assert.ok(receipt);
    const chapter = await library.openChapter(receipt.chapterIds[0]);
    assert.deepEqual(await readFile(chapter.pages[0].imagePath), bytes);
    assert.equal(chapter.pages[0].blocks.length, 0);
    assert.ok(chapter.importSource);
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
      /Native incoming|imagePath|sourcePath/,
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    assert.deepEqual(
      (await wait(client, await client.call("import_chapters", input)))
        .importReceipt,
      receipt,
    );
    const restored = await client.call("get_import_receipt", {
      requestId: input.requestId,
    });
    assert.deepEqual(restored.availableChapterIds, receipt.chapterIds);
    const restarted = client;
    await assert.rejects(() =>
      restarted.call("get_file_upload", { uploadId: upload.uploadId }),
    );
    await client.call("discard_retained", { id: receipt.id, confirm: true });
    assert.deepEqual(await readFile(chapter.pages[0].imagePath), bytes);
    assert.equal(
      (await library.listLibrary()).works.length,
      before.works.length + 1,
    );
    console.log(
      "PASS native incoming file -> real byte upload -> frozen preview -> image validation and OS-encrypted import -> reconstructed replay -> original preservation",
    );
  } finally {
    await client.close();
  }
}
/** @param {Pick<Client, "call">} client @param {Buffer} bytes @param {string} filename */
async function sendNativeFile(client, bytes, filename) {
  const upload = await client.call("begin_file_upload", {
    requestId: randomUUID(),
    filename,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  for (let offset = 0; offset < bytes.length; offset += upload.chunkBytes)
    await client.call("write_file_upload", {
      uploadId: upload.uploadId,
      offset,
      data: bytes
        .subarray(offset, offset + upload.chunkBytes)
        .toString("base64"),
    });
  return client.call("finish_file_upload", { uploadId: upload.uploadId });
}
module.exports = { checkNativeIncomingFiles, sendNativeFile };
