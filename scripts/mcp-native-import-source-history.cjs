const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { retainedClient } = require("./mcp-native-retention.cjs");

/** @typedef {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} NativeApp */
/** @typedef {Parameters<typeof retainedClient>[2]} Editing */
/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** Existing harness has already imported the original and discarded its receipt.
 * Only native file selection is automated; image bytes and stored history are real.
 * @param {string} root @param {NativeApp} app @param {Editing} editing
 * @param {string} source @param {string} workId */
async function checkNativeImportSourceHistory(
  root,
  app,
  editing,
  source,
  workId,
) {
  assert.equal(
    app.appPaths.dataRoot,
    root,
    "Only the isolated native profile may be used",
  );
  const library = require(join(root, "out/main/library.js"));
  const before = await library.listLibrary();
  const original = await readFile(source);
  const client = await retainedClient(root, app, editing);
  try {
    const job = await waitJob(
      client,
      await client.call("choose_import_files", {
        requestId: randomUUID(),
        source: "local",
        kind: "images",
      }),
    );
    assert.equal(job.status, "completed", JSON.stringify(job));
    const ref = job.result.importPreview;
    const review = await client.call("get_import_preview", {
      previewId: ref.previewId,
      snapshot: ref.snapshot,
    });
    const destination = await client.call("get_import_target", { workId });
    const selection = {
      previewId: ref.previewId,
      snapshot: ref.snapshot,
      target: { mode: "existing", workId, snapshot: destination.snapshot },
      chapters: [
        {
          draftId: review.pages[0].draftId,
          title: "Duplicate review",
          pageIds: [review.pages[0].pageId],
        },
      ],
    };
    const duplicate = await client.call("get_import_duplicates", selection);
    assert.equal(duplicate.historicalOnly, true);
    assert.equal(duplicate.historyChapterCount, 1);
    assert.equal(duplicate.chapters[0].status, "known-content");
    assert.equal(duplicate.chapters[0].matches[0].match, "content");
    assert.doesNotMatch(
      JSON.stringify(duplicate),
      /selectionSha256|sourcePath|urlSha256|dataUrl/,
    );
    const rejected = await waitJob(
      client,
      await client.call("import_chapters", {
        ...selection,
        requestId: randomUUID(),
        allowNativePreparation: true,
        duplicatePolicy: "reject-known",
      }),
    );
    assert.equal(rejected.status, "failed", JSON.stringify(rejected));
    assert.equal(rejected.error.code, "invalid_edit");
    assert.deepEqual(await library.listLibrary(), before);
    const chapter = await library.openChapter(
      duplicate.chapters[0].matches[0].chapterId,
    );
    assert.equal(chapter.importSource.version, 1);
    assert.equal(chapter.importSource.basis, "selected-input-bytes");
    assert.deepEqual(await readFile(chapter.pages[0].imagePath), original);
    assert.deepEqual(await readFile(source), original);
    console.log(
      "PASS native persistent source history -> fresh preview -> duplicate review -> rejected publication after receipt disposal",
    );
  } finally {
    await client.close();
  }
}
/** @param {Client} client @param {{jobId: string}} accepted */
async function waitJob(client, accepted) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await client.call("get_job", { jobId: accepted.jobId });
    if (job.status !== "running") return job;
    await pause(15);
  }
  throw new Error("Native source history job did not settle");
}
module.exports = { checkNativeImportSourceHistory };
