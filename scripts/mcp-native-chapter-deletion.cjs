const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, lstat } = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");

/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** Only the enclosing native import's newly created chapter is eligible.
 * @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} workId
 * @param {string} chapterId */
async function checkNativeChapterDeletion(
  root,
  app,
  editing,
  workId,
  chapterId,
) {
  assert.equal(app.appPaths.dataRoot, root);
  const library = require(join(root, "out/main/library.js"));
  const { captureChapterDeletionTree } = require(
    join(root, "out/main/mcp/mcpChapterDeletionFiles.js"),
  );
  const { McpEditorGuard } = require(
    join(root, "out/main/application/mcpEditorGuard.js"),
  );
  const directory = join(
    library.getLibraryRoot(),
    "works",
    workId,
    "chapters",
    chapterId,
  );
  const workPath = join(library.getLibraryRoot(), "works", workId, "work.json");
  const work = JSON.parse(await readFile(workPath, "utf8"));
  assert.equal(work.title, "Native grouped publication");
  const tree = await captureChapterDeletionTree(directory, () => {});
  const original = new Map();
  for (const file of tree.files)
    original.set(file.path, await readFile(join(directory, file.path)));
  // Only the trusted renderer reply is synthetic. Fresh nonce checking is real.
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
      await captureChapterDeletionTree(directory, () => {}),
      tree,
    );
    for (const [path, bytes] of original)
      assert.deepEqual(await readFile(join(directory, path)), bytes);
    assert.deepEqual(JSON.parse(await readFile(workPath, "utf8")), work);
  };
  await exerciseRemoval(
    root,
    app,
    ports,
    { workId, chapterId },
    directory,
    restored,
  );
  console.log(
    "PASS native chapter deletion -> verified OS-encrypted copy -> reconstructed exact Undo/Redo -> protected disposal -> original preservation",
  );
}

/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {{workId:string,chapterId:string}} target
 * @param {string} directory
 * @param {() => Promise<void>} restored */
async function exerciseRemoval(
  root,
  app,
  editing,
  target,
  directory,
  restored,
) {
  const library = require(join(root, "out/main/library.js"));
  let client = await retainedClient(root, app, editing);
  try {
    const review = await client.call("preview_chapter_deletion", target);
    const input = {
      ...target,
      snapshot: review.snapshot,
      requestId: randomUUID(),
      confirm: "delete-chapter-with-seven-day-recovery",
    };
    const saved = await client.call("delete_chapter", input);
    assert.equal(saved.status, "saved");
    await assert.rejects(lstat(directory), { code: "ENOENT" });
    const encrypted = await readFile(
      join(library.getLibraryRoot(), ".mcp-retained", saved.id, "record.json"),
      "utf8",
    );
    assert.doesNotMatch(encrypted, /chapterOrder|Native grouped publication/);
    await assert.rejects(
      client.call("discard_retained", { id: saved.id, confirm: true }),
    );
    await assert.rejects(
      client.call("discard_chapter_deletion", { id: saved.id, confirm: true }),
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    assert.equal((await client.call("delete_chapter", input)).historical, true);
    const records = await client.call("list_chapter_deletions", {});
    assert.ok(
      records.items.some(
        (/** @type {{id:string}} */ item) => item.id === saved.id,
      ),
    );
    const undo = await recover(client, saved.id, "undo");
    await restored();
    assert.equal(
      (await client.call("undo_chapter_deletion", undo)).historical,
      true,
    );
    assert.equal((await client.call("delete_chapter", input)).historical, true);
    await restored();
    await client.close();
    client = await retainedClient(root, app, editing);
    await recover(client, saved.id, "redo");
    await assert.rejects(lstat(directory), { code: "ENOENT" });
    await recover(client, saved.id, "undo");
    await restored();
    await client.call("discard_chapter_deletion", {
      id: saved.id,
      confirm: true,
    });
    const final = client;
    await assert.rejects(() =>
      final.call("get_chapter_deletion", { id: saved.id }),
    );
    await restored();
  } finally {
    await client.close();
  }
}
/** @param {Client} client @param {string} id @param {"undo" | "redo"} direction */
async function recover(client, id, direction) {
  const view = await client.call("get_chapter_deletion", { id });
  assert.equal(direction === "undo" ? view.canUndo : view.canRedo, true);
  const input = {
    id,
    snapshot: view.snapshot,
    requestId: randomUUID(),
    confirm: true,
  };
  assert.equal(
    (await client.call(`${direction}_chapter_deletion`, input)).status,
    "saved",
  );
  return input;
}
module.exports = { checkNativeChapterDeletion };
