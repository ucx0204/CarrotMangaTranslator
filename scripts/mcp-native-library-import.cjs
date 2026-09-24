const { checkNativeWorkFile } = require("./mcp-native-work-file.cjs");
const { checkNativeIncomingFiles } = require("./mcp-native-incoming-files.cjs");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { dialog, nativeImage } = require("electron");
const { retainedClient } = require("./mcp-native-retention.cjs");
const {
  checkNativeImportPublication,
} = require("./mcp-native-import-publication.cjs");
const {
  checkNativeImportSourceHistory,
} = require("./mcp-native-import-source-history.cjs");

/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** The outer smoke harness owns this isolated profile and real Electron lifetime.
 * Only native file selection is automated; image validation/import/encryption are real.
 * @param {string} root */
async function checkNativeLibraryImport(root) {
  const { getAppPaths } = require(join(root, "out/main/appPaths.js"));
  const { ActiveJobStore } = require(join(root, "out/main/jobs/activeJob.js"));
  const { libraryMutationCoordinator } = require(
    join(root, "out/main/libraryStore/libraryMutationCoordinator.js"),
  );
  const library = require(join(root, "out/main/library.js"));
  assert.equal(
    getAppPaths().dataRoot,
    root,
    "Never import into a real user profile",
  );
  const jobs = new ActiveJobStore({ info: () => {}, error: () => {} });
  const app = {
    jobs,
    appPaths: getAppPaths(),
    getMainWindow: () => null,
    decodeImage: async () => null,
  };
  const editing = {
    assertWritable: async () => {},
    assertClean: async () => {},
    notifySaved: () => {},
  };
  libraryMutationCoordinator.configureActivityGate(jobs.gate);
  const source = join(root, "native-selected-import.png");
  const bytes = nativeImage
    .createFromBitmap(Buffer.alloc(12 * 16 * 4, 255), { width: 12, height: 16 })
    .toPNG();
  await writeFile(source, bytes);
  const before = await library.listLibrary();
  const originalPicker = dialog.showOpenDialog;
  let picks = 0;
  dialog.showOpenDialog = async () => {
    picks++;
    return { canceled: false, filePaths: [source] };
  };
  /** @type {Client | undefined} */
  let client;
  try {
    client = await retainedClient(root, app, editing);
    const prepared = await waitImport(
      client,
      await client.call("choose_import_files", {
        requestId: randomUUID(),
        source: "local",
        kind: "images",
      }),
    );
    const ref = prepared.importPreview;
    assert.ok(ref);
    assert.deepEqual(await library.listLibrary(), before);
    const review = await client.call("get_import_preview", {
      previewId: ref.previewId,
      snapshot: ref.snapshot,
    });
    assert.equal(review.pages.length, 1);
    const input = {
      requestId: randomUUID(),
      previewId: ref.previewId,
      snapshot: ref.snapshot,
      allowNativePreparation: true,
      target: { mode: "new", title: "Native import work" },
      chapters: [
        {
          draftId: review.pages[0].draftId,
          title: "Native import chapter",
          pageIds: [review.pages[0].pageId],
        },
      ],
    };
    const imported = await waitImport(
      client,
      await client.call("import_chapters", input),
    );
    const receipt = imported.importReceipt;
    assert.ok(receipt);
    const chapter = await library.openChapter(receipt.chapterIds[0]);
    assert.equal(chapter.pages.length, 1);
    assert.equal(chapter.pages[0].blocks.length, 0);
    assert.deepEqual(await readFile(chapter.pages[0].imagePath), bytes);
    assert.deepEqual(await readFile(source), bytes);
    const encrypted = await readFile(
      join(
        library.getLibraryRoot(),
        ".mcp-retained",
        receipt.id,
        "record.json",
      ),
      "utf8",
    );
    assert.doesNotMatch(
      encrypted,
      /Native import work|Native import chapter|native-selected-import/,
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    const restored = await client.call("get_import_receipt", {
      requestId: input.requestId,
    });
    assert.deepEqual(restored.availableChapterIds, receipt.chapterIds);
    const replay = await waitImport(
      client,
      await client.call("import_chapters", input),
    );
    assert.deepEqual(replay.importReceipt, receipt);
    assert.equal(picks, 1);
    assert.equal(
      (await library.listLibrary()).works.length,
      before.works.length + 1,
    );
    const reconstructed = client;
    await assert.rejects(() =>
      reconstructed.call("get_import_preview", {
        previewId: ref.previewId,
        snapshot: ref.snapshot,
      }),
    );
    await client.call("discard_retained", { id: receipt.id, confirm: true });
    assert.deepEqual(
      await readFile(
        (await library.openChapter(receipt.chapterIds[0])).pages[0].imagePath,
      ),
      bytes,
    );
    assert.deepEqual(await readFile(source), bytes);
    console.log(
      "PASS native selected import -> real image validation -> atomic OS-encrypted receipt -> reconstructed replay -> receipt disposal preserves imported pages and original",
    );
    await client.close();
    client = undefined;
    await checkNativeImportSourceHistory(
      root,
      app,
      editing,
      source,
      receipt.workId,
    );
    await checkNativeImportPublication(root, app, editing, source);
    const picksBeforeIncoming = picks;
    await checkNativeIncomingFiles(root, app, editing, bytes, waitImport);
    await checkNativeWorkFile(
      root,
      app,
      editing,
      receipt.chapterIds[0],
      waitImport,
    );
    assert.equal(picks, picksBeforeIncoming);
  } finally {
    dialog.showOpenDialog = originalPicker;
    await client?.close();
    libraryMutationCoordinator.configureActivityGate(null);
  }
}
/** @param {Client} client @param {{jobId:string}} accepted */
async function waitImport(client, accepted) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await client.call("get_job", { jobId: accepted.jobId });
    if (job.status === "completed") return job.result;
    assert.equal(job.status, "running", JSON.stringify(job));
    await pause(15);
  }
  throw new Error("Native import did not settle");
}
module.exports = { checkNativeLibraryImport };
