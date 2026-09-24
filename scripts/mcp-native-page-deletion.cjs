const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { lstat, readFile, writeFile, unlink } = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");

/** Only the enclosing import fixture's chapter is eligible; never a user data root.
 * @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} chapterId */
async function checkNativePageDeletion(root, app, editing, chapterId) {
  assert.equal(app.appPaths.dataRoot, root);
  const library = require(join(root, "out/main/library.js"));
  const { captureChapterDeletionTree } = require(
    join(root, "out/main/mcp/mcpChapterDeletionFiles.js"),
  );
  const { McpEditorGuard } = require(
    join(root, "out/main/application/mcpEditorGuard.js"),
  );
  const chapter = await library.openChapter(chapterId);
  assert.equal(
    chapter.pages.length,
    1,
    "Only the enclosing single-page imported chapter",
  );
  const target = {
    workId: chapter.workId,
    chapterId,
    pageId: chapter.pages[0].id,
  };
  const directory = join(
    library.getLibraryRoot(),
    "works",
    chapter.workId,
    "chapters",
    chapterId,
  );
  const workPath = join(
    library.getLibraryRoot(),
    "works",
    chapter.workId,
    "work.json",
  );
  const capture = async () => ({
    tree: await captureChapterDeletionTree(directory, () => {}),
    work: JSON.parse(await readFile(workPath, "utf8")),
  });
  const original = await capture();
  const memoryPath = join(directory, "story-memory.json");
  await assert.rejects(lstat(memoryPath), { code: "ENOENT" });
  const guard = new McpEditorGuard(
    () => false,
    (/** @type {number} */ probeId) => {
      guard.report({
        probeId,
        chapterId: null,
        dirtyPageIds: [],
        hasPendingInpaintingMask: false,
      });
    },
  );
  const ports = {
    ...editing,
    assertChapterClosed: (/** @type {string} */ id) =>
      guard.assertChapterClosed(id),
  };
  await exercise(root, app, ports, target, async () => {
    assert.deepEqual(await capture(), original);
    await assert.rejects(lstat(memoryPath), { code: "ENOENT" });
  });
  await writeFile(
    memoryPath,
    JSON.stringify({
      schemaVersion: 1,
      workId: chapter.workId,
      chapterId,
      pages: [
        {
          pageId: target.pageId,
          pageName: chapter.pages[0].name,
          pageIndex: 0,
          sourceDigest: "source",
          translatedDigest: "translation",
          summary: "Native manual memory",
          visualSummary: "Manual scene",
          visualSummarySource: "manual",
          updatedAt: "2026-09-21T00:00:00.000Z",
        },
      ],
      updatedAt: "2026-09-21T00:00:00.000Z",
    }),
  );
  const withMemory = await capture();
  await exercise(root, app, ports, target, async () =>
    assert.deepEqual(await capture(), withMemory),
  );
  // This is the one fixture-created file, removed only after exact restoration.
  await unlink(memoryPath);
  assert.deepEqual(await capture(), original);
  console.log(
    "PASS native page deletion -> exact source and memory -> OS-encrypted archive -> reconstructed Undo/Redo -> empty chapter and original preservation",
  );
}

/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {{workId:string, chapterId:string, pageId:string}} target
 * @param {() => Promise<void>} restored */
async function exercise(root, app, editing, target, restored) {
  const library = require(join(root, "out/main/library.js"));
  let client = await retainedClient(root, app, editing);
  try {
    const review = await client.call("preview_page_deletion", target);
    assert.equal(review.pageCount, 1);
    assert.equal(review.remainingPages, 0);
    const input = {
      ...target,
      snapshot: review.snapshot,
      requestId: randomUUID(),
      confirm: "delete-page-with-seven-day-recovery",
    };
    const saved = await client.call("delete_page", input);
    assert.equal(saved.status, "saved");
    assert.equal((await library.openChapter(target.chapterId)).pages.length, 0);
    const encrypted = await readFile(
      join(library.getLibraryRoot(), ".mcp-retained", saved.id, "record.json"),
      "utf8",
    );
    assert.doesNotMatch(
      encrypted,
      /Native manual memory|imagePath|translatedText|"parts"/,
    );
    await assert.rejects(
      client.call("discard_page_deletion", { id: saved.id, confirm: true }),
    );
    await assert.rejects(
      client.call("discard_retained", { id: saved.id, confirm: true }),
    );
    for (const direction of ["undo", "redo", "undo"]) {
      await client.close();
      client = await retainedClient(root, app, editing);
      const view = await client.call("get_page_deletion", { id: saved.id });
      assert.equal(direction === "undo" ? view.canUndo : view.canRedo, true);
      const action = {
        id: saved.id,
        snapshot: view.snapshot,
        requestId: randomUUID(),
        confirm: true,
      };
      assert.equal(
        (await client.call(`${direction}_page_deletion`, action)).status,
        "saved",
      );
      assert.equal(
        (await client.call(`${direction}_page_deletion`, action)).historical,
        true,
      );
      assert.equal((await client.call("delete_page", input)).historical, true);
      if (direction === "undo") await restored();
      else
        assert.equal(
          (await library.openChapter(target.chapterId)).pages.length,
          0,
        );
    }
    await client.call("discard_page_deletion", { id: saved.id, confirm: true });
    await restored();
    assert.equal((await client.call("list_page_deletions", {})).total, 0);
  } finally {
    await client.close();
  }
}
module.exports = { checkNativePageDeletion };
