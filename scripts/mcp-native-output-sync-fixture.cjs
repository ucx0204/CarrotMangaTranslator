const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { nativeImage } = require("electron");

/** @typedef {import("./mcp-native-output-sync-client.cjs").NativeApp} NativeApp */
/** @typedef {Awaited<ReturnType<typeof seedOutputSyncFixture>>} Fixture */

/** New synthetic pages in the caller's owned temporary profile only.
 * @param {string} root @param {string} sourceChapterId */
async function seedOutputSyncFixture(root, sourceChapterId) {
  const library = require(join(root, "out/main/library.js"));
  const { getAppPaths } = require(join(root, "out/main/appPaths.js"));
  assert.equal(getAppPaths().dataRoot, root);
  const upstream = await library.openChapter(sourceChapterId);
  const upstreamBytes = await Promise.all(
    upstream.pages.map(
      async (
        /** @type {import("../src/shared/libraryTypes").MangaPage} */ page,
      ) => ({
        path: page.imagePath,
        bytes: await readFile(page.imagePath),
      }),
    ),
  );
  const bitmap = Buffer.alloc(128 * 192 * 4, 255);
  for (let y = 168; y < 180; y++)
    for (let x = 108; x < 120; x++)
      bitmap.fill(0, (y * 128 + x) * 4, (y * 128 + x) * 4 + 3);
  const sourcePath = join(root, "native-output-sync-original.png");
  const image = nativeImage
    .createFromBitmap(bitmap, { width: 128, height: 192 })
    .toPNG();
  await writeFile(sourcePath, image);
  const draftId = randomUUID();
  const imported = await library.createImport({
    preview: {
      mode: "batch",
      sourceKind: "images",
      suggestedWorkTitle: "Native output sync fixture",
      chapters: [
        {
          draftId,
          title: "Native linked output",
          sourceKind: "images",
          pages: ["selected.png", "mirror-only.png"].map((name) => ({
            name,
            sourcePath,
            sourceKind: "file",
          })),
        },
      ],
    },
    target: { mode: "new", title: "Native output sync fixture" },
    selections: [{ draftId, title: "Native linked output", enabled: true }],
  });
  const chapterId = imported.chapterIds[0];
  const chapter = await library.openChapter(chapterId);
  for (const page of chapter.pages)
    await library.savePageBlocks({
      chapterId,
      pageId: page.id,
      blocks: [
        {
          id: "saved-text",
          type: "nonsolid",
          bbox: { x: 8, y: 8, w: 90, h: 60 },
          sourceText: "Original source",
          translatedText: "Native sync",
          confidence: 1,
          sourceDirection: "horizontal",
          renderDirection: "horizontal",
          fontSizePx: 14,
          lineHeight: 1.2,
          textAlign: "center",
          textColor: "#000000",
          backgroundColor: "#ffffff",
          opacity: 1,
        },
      ],
    });
  const saved = await library.openChapter(chapterId);
  const output = join(root, "native-output-sync-approved");
  await mkdir(output);
  return {
    chapter: saved,
    sourcePath,
    image,
    bitmap,
    output,
    upstream,
    upstreamBytes,
  };
}

/** One initialized native owner, with the actual renderer and writer dependencies.
 * @param {string} root @param {NativeApp} app @param {Fixture} fixture */
async function createOutputSyncNativeOwner(root, app, fixture) {
  assert.equal(app.appPaths.dataRoot, root);
  const { LinkedWorkspaceSyncService } = require(
    join(root, "out/main/linkedWorkspace/linkedWorkspaceSyncService.js"),
  );
  const { DEFAULT_RASTER_EXPORT_SETTINGS } = require(
    join(root, "out/shared/linkedWorkspaceTypes.js"),
  );
  const library = require(join(root, "out/main/library.js"));
  const { createPageExportRenderSession } = require(
    join(root, "out/main/pageExport.js"),
  );
  /** @type {unknown[]} */
  const errors = [];
  const native = new LinkedWorkspaceSyncService({
    dataRoot: root,
    jobs: app.jobs,
    decodeImage: app.decodeImage,
    getMainWindow: app.getMainWindow,
    reportError: (
      /** @type {string} */ _message,
      /** @type {unknown} */ error,
    ) => errors.push(error),
    dependencies: {
      listLibrary: library.listLibrary,
      openChapter: library.openChapter,
      updatePagesAfterInpainting: library.updatePagesAfterInpainting,
      createPageExportRenderSession,
    },
  });
  // Hold only this fixture's automatic idle worker through its existing UI gate.
  // The reviewed API does not use that worker, and no queue item is executed.
  native.reportActivity({ type: "start", interaction: "pointer" });
  try {
    await native.initialize();
    await native.connect({
      workId: fixture.chapter.workId,
      chapterId: fixture.chapter.id,
      rootPath: fixture.output,
      enqueueExistingPages: false,
      output: {
        ...DEFAULT_RASTER_EXPORT_SETTINGS,
        format: "png",
        destinationMode: "fixed",
      },
    });
    const connectionId = native.getStatus(fixture.chapter.id).connectionId;
    assert.ok(connectionId);
    const queue = await waitOutputSyncQueue(
      root,
      connectionId,
      fixture.chapter.pages.length,
    );
    return {
      native,
      errors,
      queue,
      selection: {
        chapterId: fixture.chapter.id,
        connectionId,
        pageIds: [fixture.chapter.pages[0].id],
      },
    };
  } catch (error) {
    try {
      await native.dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Native output fixture initialization and cleanup failed",
        { cause: cleanup },
      );
    }
    throw error;
  }
}

/** Await the real queue persistence boundary without triggering its worker.
 * @param {string} root @param {string} connectionId @param {number} count */
async function waitOutputSyncQueue(root, connectionId, count) {
  const path = join(root, "linked-sync-queue.json");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const bytes = await readFile(path, "utf8");
    if (
      JSON.parse(bytes).items.filter(
        (/** @type {{connectionId:string}} */ item) =>
          item.connectionId === connectionId,
      ).length === count
    )
      return bytes;
    await pause(25);
  }
  throw new Error("Native queue admission was not persisted");
}

/** Existing empty-editor acknowledgement boundary, restricted to this fixture.
 * @param {NativeApp} app @param {Fixture} fixture */
function outputSyncFixtureHandoffs(app, fixture) {
  /** @type {Set<string>} */
  const acknowledged = new Set();
  /** @type {Set<string>} */
  const blocked = new Set();
  /** @type {((jobId:string)=>void) | undefined} */
  let cancelNext;
  const stop = app.jobs.pageHandoffs.subscribe(() => {
    for (const page of app.jobs.pageHandoffs.activities) {
      if (
        page.chapterId !== fixture.chapter.id ||
        page.phase !== "finishing-edits" ||
        !page.requestId
      )
        continue;
      if (blocked.has(page.jobId)) continue;
      if (cancelNext) {
        const cancel = cancelNext;
        cancelNext = undefined;
        blocked.add(page.jobId);
        cancel(page.jobId);
      } else if (app.jobs.pageHandoffs.respond({ requestId: page.requestId }))
        acknowledged.add(page.pageId);
    }
  });
  return {
    acknowledged,
    stop,
    /** @param {(jobId:string)=>void} cancel */
    cancelNext: (cancel) => {
      cancelNext = cancel;
    },
  };
}

/** @param {string} root @param {Fixture} fixture */
async function assertOutputSyncOriginals(root, fixture) {
  const library = require(join(root, "out/main/library.js"));
  const { capturePageRecovery } = require(
    join(root, "out/shared/pageRecoverySnapshot.js"),
  );
  const current = await library.openChapter(fixture.chapter.id);
  assert.deepEqual(
    current.pages.map(capturePageRecovery),
    fixture.chapter.pages.map(capturePageRecovery),
  );
  for (const page of current.pages)
    assert.deepEqual(await readFile(page.imagePath), fixture.image);
  assert.deepEqual(await readFile(fixture.sourcePath), fixture.image);
  assert.deepEqual(
    await library.openChapter(fixture.upstream.id),
    fixture.upstream,
  );
  for (const original of fixture.upstreamBytes)
    assert.deepEqual(await readFile(original.path), original.bytes);
}
module.exports = {
  seedOutputSyncFixture,
  createOutputSyncNativeOwner,
  outputSyncFixtureHandoffs,
  assertOutputSyncOriginals,
};
