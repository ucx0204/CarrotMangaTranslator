const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  mkdir,
  readFile,
  writeFile,
  unlink,
  rmdir,
  lstat,
} = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");

/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} workId @param {string} chapterId */
async function checkNativeChapterMove(root, app, editing, workId, chapterId) {
  assert.equal(
    app.appPaths.dataRoot,
    root,
    "Only the enclosing smoke-owned profile is eligible",
  );
  const library = require(join(root, "out/main/library.js"));
  const { McpEditorGuard } = require(
    join(root, "out/main/application/mcpEditorGuard.js"),
  );
  const { captureChapterDeletionTree } = require(
    join(root, "out/main/mcp/mcpChapterDeletionFiles.js"),
  );
  const base = library.getLibraryRoot();
  const sourceWorkPath = join(base, "works", workId, "work.json");
  const sourceWork = JSON.parse(await readFile(sourceWorkPath, "utf8"));
  assert.equal(sourceWork.title, "Native grouped publication");
  const chapter = await library.openChapter(chapterId);
  const directory = join(base, "works", workId, "chapters", chapterId);
  const memoryPath = join(directory, "story-memory.json");
  await assert.rejects(lstat(memoryPath), { code: "ENOENT" });
  const memory = {
    schemaVersion: 1,
    workId,
    chapterId,
    pages: [
      {
        pageId: chapter.pages[0].id,
        pageName: chapter.pages[0].name,
        pageIndex: 0,
        sourceDigest: "Native move source",
        translatedDigest: "Native move translation",
        summary: "Native move private memory",
        visualSummary: "Native move manual scene",
        visualSummarySource: "manual",
        updatedAt: "2026-09-21T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
  await writeFile(memoryPath, JSON.stringify(memory));
  const originalTree = await captureChapterDeletionTree(directory, () => {});
  const destinationWorkId = randomUUID();
  const destination = join(base, "works", destinationWorkId);
  const indexPath = join(base, "index.json"),
    indexBytes = await readFile(indexPath);
  const index = JSON.parse(indexBytes.toString());
  const work = {
    ...sourceWork,
    id: destinationWorkId,
    title: "Native move destination",
    chapterOrder: [],
  };
  await mkdir(join(destination, "chapters"), { recursive: true });
  await writeFile(join(destination, "work.json"), JSON.stringify(work));
  await writeFile(
    indexPath,
    JSON.stringify({
      ...index,
      workOrder: [...index.workOrder, destinationWorkId],
    }),
  );
  // Only the trusted renderer reply is synthetic; nonce validation is real.
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
      originalTree,
    );
    assert.deepEqual(await library.openChapter(chapterId), chapter);
    assert.deepEqual(
      JSON.parse(await readFile(sourceWorkPath, "utf8")),
      sourceWork,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(destination, "work.json"), "utf8")),
      work,
    );
  };
  try {
    await exerciseMove(
      root,
      app,
      ports,
      { workId, chapterId, destinationWorkId },
      directory,
      memory,
      restored,
    );
    await restored();
    console.log(
      "PASS native chapter move -> existing work relocation -> OS-encrypted originals -> reconstructed exact Undo/Redo -> original IDs and bytes preserved",
    );
  } finally {
    // Remove only fixture-owned files after exact restoration; no recursive deletion.
    await restored();
    await unlink(memoryPath);
    await rmdir(join(destination, "chapters"));
    await unlink(join(destination, "work.json"));
    await rmdir(destination);
    await writeFile(indexPath, indexBytes);
  }
}

/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {{workId:string,chapterId:string,destinationWorkId:string}} intent
 * @param {string} directory
 * @param {object} memory
 * @param {() => Promise<void>} restored */
async function exerciseMove(
  root,
  app,
  editing,
  intent,
  directory,
  memory,
  restored,
) {
  const library = require(join(root, "out/main/library.js"));
  let client = await retainedClient(root, app, editing);
  try {
    const review = await client.call("preview_chapter_move", { intent });
    assert.equal(review.eligible, true);
    assert.equal(review.memoryPresent, true);
    assert.doesNotMatch(
      JSON.stringify(review),
      /imagePath|sourceText|dataUrl|Native move private memory/,
    );
    const input = {
      intent,
      snapshot: review.snapshot,
      planFingerprint: review.planFingerprint,
      requestId: randomUUID(),
      confirm: "move-chapter-between-existing-works",
    };
    const saved = await client.call("move_chapter", input);
    assert.equal(saved.status, "saved");
    await assert.rejects(lstat(directory), { code: "ENOENT" });
    const moved = await library.openChapter(intent.chapterId);
    assert.equal(moved.workId, intent.destinationWorkId);
    const movedMemoryPath = join(
      library.getLibraryRoot(),
      "works",
      intent.destinationWorkId,
      "chapters",
      intent.chapterId,
      "story-memory.json",
    );
    assert.deepEqual(JSON.parse(await readFile(movedMemoryPath, "utf8")), {
      ...memory,
      workId: intent.destinationWorkId,
    });
    const encrypted = await readFile(
      join(library.getLibraryRoot(), ".mcp-retained", saved.id, "record.json"),
      "utf8",
    );
    assert.doesNotMatch(
      encrypted,
      /Native move destination|Native move private memory|chapterOrder|imagePath/,
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    assert.equal((await client.call("move_chapter", input)).historical, true);
    const list = await client.call("list_chapter_moves", {});
    assert.ok(
      list.items.some(
        (/** @type {{id:string}} */ item) => item.id === saved.id,
      ),
    );
    for (const direction of ["undo", "redo", "undo"]) {
      const view = await client.call("get_chapter_move", { id: saved.id });
      assert.equal(direction === "undo" ? view.canUndo : view.canRedo, true);
      const action = {
        id: saved.id,
        snapshot: view.snapshot,
        requestId: randomUUID(),
        confirm: true,
      };
      assert.equal(
        (await client.call(`${direction}_chapter_move`, action)).status,
        "saved",
      );
      assert.equal(
        (await client.call(`${direction}_chapter_move`, action)).historical,
        true,
      );
      assert.equal((await client.call("move_chapter", input)).historical, true);
      if (direction === "undo") await restored();
      else
        assert.equal(
          (await library.openChapter(intent.chapterId)).workId,
          intent.destinationWorkId,
        );
      await client.close();
      client = await retainedClient(root, app, editing);
    }
    await client.call("discard_retained", { id: saved.id, confirm: true });
    const final = client;
    await assert.rejects(() =>
      final.call("get_chapter_move", { id: saved.id }),
    );
    await restored();
  } finally {
    await client.close();
  }
}
module.exports = { checkNativeChapterMove };
