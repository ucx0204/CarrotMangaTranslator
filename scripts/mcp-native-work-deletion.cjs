const { checkNativeWorkCapacity } = require("./mcp-native-work-capacity.cjs");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, writeFile, lstat, unlink } = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");

/** Only the enclosing isolated import's two-chapter work is eligible.
 * @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} workId @param {string[]} chapterIds */
async function checkNativeWorkDeletion(root, app, editing, workId, chapterIds) {
  assert.equal(app.appPaths.dataRoot, root, "Use only the smoke-owned profile");
  assert.equal(chapterIds.length, 2);
  const library = require(join(root, "out/main/library.js"));
  const { captureChapterDeletionTree } = require(
    join(root, "out/main/mcp/mcpChapterDeletionFiles.js"),
  );
  const { McpEditorGuard } = require(
    join(root, "out/main/application/mcpEditorGuard.js"),
  );
  const base = library.getLibraryRoot();
  const directory = join(base, "works", workId);
  const work = JSON.parse(await readFile(join(directory, "work.json"), "utf8"));
  assert.equal(work.title, "Native grouped publication");
  assert.deepEqual(work.chapterOrder, chapterIds);
  const beforeTree = await captureChapterDeletionTree(
    directory,
    () => {},
    "work.json",
  );
  const indexPath = join(base, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8"));
  const memoryPath = join(
    directory,
    "chapters",
    chapterIds[0],
    "story-memory.json",
  );
  await assert.rejects(lstat(memoryPath), { code: "ENOENT" });
  await writeFile(
    memoryPath,
    JSON.stringify({
      schemaVersion: 1,
      workId,
      chapterId: chapterIds[0],
      pages: [],
      updatedAt: "2026-09-21T00:00:00.000Z",
    }),
  );
  const tree = await captureChapterDeletionTree(
    directory,
    () => {},
    "work.json",
  );
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
  const restored = async () => {
    assert.deepEqual(
      await captureChapterDeletionTree(directory, () => {}, "work.json"),
      tree,
    );
    assert.deepEqual(JSON.parse(await readFile(indexPath, "utf8")), index);
  };
  await exerciseWorkRemoval(root, app, ports, workId, directory, restored);
  await restored();
  await unlink(memoryPath);
  assert.deepEqual(
    await captureChapterDeletionTree(directory, () => {}, "work.json"),
    beforeTree,
  );
  await checkNativeWorkCapacity(root, app, workId, (directory, restored) =>
    exerciseWorkRemoval(root, app, ports, workId, directory, restored),
  );
  console.log(
    "PASS native work deletion -> all chapters and context -> verified OS-encrypted archive -> reconstructed exact Undo/Redo -> protected disposal and original preservation",
  );
}

/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} workId @param {string} directory @param {() => Promise<void>} restored */
async function exerciseWorkRemoval(
  root,
  app,
  editing,
  workId,
  directory,
  restored,
) {
  const library = require(join(root, "out/main/library.js"));
  let client = await retainedClient(root, app, editing);
  try {
    const review = await client.call("preview_work_deletion", { workId });
    assert.equal(review.chapters.length, 2);
    assert.doesNotMatch(
      JSON.stringify(review),
      /imagePath|sourceText|dataUrl|story-memory/,
    );
    const input = {
      workId,
      snapshot: review.snapshot,
      requestId: randomUUID(),
      confirm: "delete-work-with-seven-day-recovery",
    };
    const saved = await client.call("delete_work", input);
    assert.equal(saved.status, "saved");
    await assert.rejects(lstat(directory), { code: "ENOENT" });
    assert.doesNotMatch(
      await readFile(
        join(
          library.getLibraryRoot(),
          ".mcp-retained",
          saved.id,
          "record.json",
        ),
        "utf8",
      ),
      /Native grouped publication|chapterOrder|workOrder/,
    );
    await assert.rejects(
      client.call("discard_retained", { id: saved.id, confirm: true }),
    );
    await assert.rejects(
      client.call("discard_work_deletion", { id: saved.id, confirm: true }),
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    assert.equal((await client.call("delete_work", input)).historical, true);
    const list = await client.call("list_work_deletions", {});
    assert.ok(
      list.items.some(
        (/** @type {{id: string}} */ item) => item.id === saved.id,
      ),
    );
    for (const direction of ["undo", "redo", "undo"]) {
      const view = await client.call("get_work_deletion", { id: saved.id });
      assert.equal(direction === "undo" ? view.canUndo : view.canRedo, true);
      const action = {
        id: saved.id,
        snapshot: view.snapshot,
        requestId: randomUUID(),
        confirm: true,
      };
      assert.equal(
        (await client.call(`${direction}_work_deletion`, action)).status,
        "saved",
      );
      assert.equal(
        (await client.call(`${direction}_work_deletion`, action)).historical,
        true,
      );
      assert.equal((await client.call("delete_work", input)).historical, true);
      if (direction === "undo") await restored();
      else await assert.rejects(lstat(directory), { code: "ENOENT" });
      await client.close();
      client = await retainedClient(root, app, editing);
    }
    await client.call("discard_work_deletion", { id: saved.id, confirm: true });
    const final = client;
    await assert.rejects(() =>
      final.call("get_work_deletion", { id: saved.id }),
    );
    await restored();
  } finally {
    await client.close();
  }
}
module.exports = { checkNativeWorkDeletion };
