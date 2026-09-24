const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");
const {
  checkNativeChapterDeletion,
} = require("./mcp-native-chapter-deletion.cjs");
const { checkNativePageOrder } = require("./mcp-native-page-order.cjs");
const { checkNativePageDeletion } = require("./mcp-native-page-deletion.cjs");
const { checkNativeChapterMove } = require("./mcp-native-chapter-move.cjs");
const { checkNativeWorkDeletion } = require("./mcp-native-work-deletion.cjs");

/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** Uses only the two chapters created by the enclosing isolated import test.
 * Native library publication, OS encryption and registered output contracts are real.
 * @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} workId
 * @param {string[]} chapterIds */
async function checkNativeLibraryOrganization(
  root,
  app,
  editing,
  workId,
  chapterIds,
) {
  assert.equal(app.appPaths.dataRoot, root, "Use only the smoke-owned profile");
  assert.equal(chapterIds.length, 2);
  const library = require(join(root, "out/main/library.js"));
  const workPath = join(library.getLibraryRoot(), "works", workId, "work.json");
  const beforeWork = JSON.parse(await readFile(workPath, "utf8"));
  assert.equal(beforeWork.title, "Native grouped publication");
  const chapters = await Promise.all(
    chapterIds.map((id) => library.openChapter(id)),
  );
  const images = await Promise.all(
    chapters.map((chapter) => readFile(chapter.pages[0].imagePath)),
  );
  const intents = [
    { kind: "rename-work", workId, title: "Native organization work" },
    {
      kind: "rename-chapter",
      workId,
      chapterId: chapterIds[0],
      title: chapters[1].title,
    },
    {
      kind: "reorder-chapters",
      workId,
      chapterIds: [...beforeWork.chapterOrder].reverse(),
    },
  ];
  for (const intent of intents) {
    await exerciseChange(root, app, editing, intent);
    assert.deepEqual(JSON.parse(await readFile(workPath, "utf8")), beforeWork);
    for (const [index, id] of chapterIds.entries()) {
      const restored = await library.openChapter(id);
      assert.deepEqual(restored, chapters[index]);
      assert.deepEqual(
        await readFile(restored.pages[0].imagePath),
        images[index],
      );
    }
  }
  await checkNativePageOrder(root, app, editing, chapterIds[0]);
  await checkNativePageDeletion(root, app, editing, chapterIds[0]);
  await checkNativeChapterDeletion(root, app, editing, workId, chapterIds[1]);
  await checkNativeChapterMove(root, app, editing, workId, chapterIds[1]);
  await checkNativeWorkDeletion(root, app, editing, workId, chapterIds);
  console.log(
    "PASS native library organization -> reviewed names/order -> OS-encrypted recovery -> reconstructed undo/redo -> exact metadata and source preservation",
  );
}

/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {object} intent */
async function exerciseChange(root, app, editing, intent) {
  const library = require(join(root, "out/main/library.js"));
  let client = await retainedClient(root, app, editing);
  try {
    const review = await client.call("preview_library_change", { intent });
    assert.equal(review.changed, true);
    const input = {
      intent: review.intent,
      snapshot: review.snapshot,
      planFingerprint: review.planFingerprint,
      requestId: randomUUID(),
    };
    const saved = await client.call("apply_library_change", input);
    assert.equal(saved.status, "saved");
    const encrypted = await readFile(
      join(library.getLibraryRoot(), ".mcp-retained", saved.id, "record.json"),
      "utf8",
    );
    assert.doesNotMatch(
      encrypted,
      /Native organization work|Native grouped publication|chapterOrder/,
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    const records = await client.call("list_library_changes", {});
    assert.ok(
      records.items.some(
        (/** @type {{id:string}} */ item) => item.id === saved.id,
      ),
    );
    const undo = await recover(client, saved.id, "undo");
    const repeated = await client.call("undo_library_change", undo);
    assert.equal(repeated.historical, true);
    assert.equal(
      (await client.call("apply_library_change", input)).historical,
      true,
    );
    assert.equal(
      (await client.call("get_library_change", { id: saved.id })).applied,
      false,
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    await recover(client, saved.id, "redo");
    await recover(client, saved.id, "undo");
    await client.call("discard_retained", { id: saved.id, confirm: true });
    const final = client;
    await assert.rejects(() =>
      final.call("get_library_change", { id: saved.id }),
    );
  } finally {
    await client.close();
  }
}

/** @param {Client} client @param {string} id @param {"undo" | "redo"} direction */
async function recover(client, id, direction) {
  const view = await client.call("get_library_change", { id });
  assert.equal(direction === "undo" ? view.canUndo : view.canRedo, true);
  const input = { id, snapshot: view.snapshot, requestId: randomUUID() };
  const saved = await client.call(`${direction}_library_change`, input);
  assert.equal(saved.status, "saved");
  return input;
}
module.exports = { checkNativeLibraryOrganization };
