const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { copyFile, readFile, writeFile, unlink } = require("node:fs/promises");
const { dirname, join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");

/** Only mutates the enclosing smoke's newly imported chapter in its isolated root.
 * @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} chapterId */
async function checkNativePageOrder(root, app, editing, chapterId) {
  assert.equal(app.appPaths.dataRoot, root, "Use only the smoke-owned profile");
  const library = require(join(root, "out/main/library.js"));
  const opened = await library.openChapter(chapterId);
  const directory = join(
    library.getLibraryRoot(),
    "works",
    opened.workId,
    "chapters",
    chapterId,
  );
  const path = join(directory, "chapter.json"),
    memoryPath = join(directory, "story-memory.json");
  const original = await readFile(path);
  await assert.rejects(readFile(memoryPath), { code: "ENOENT" });
  const stored = JSON.parse(original.toString("utf8"));
  const imagePath = join(
    dirname(stored.pages[0].imagePath),
    "page-order-fixture.png",
  );
  await copyFile(stored.pages[0].imagePath, imagePath);
  const second = {
    ...stored.pages[0],
    id: randomUUID(),
    name: "Second native page",
    imagePath,
  };
  stored.pages.push(second);
  stored.pageOrder.push(second.id);
  const memory = {
    schemaVersion: 1,
    workId: stored.workId,
    chapterId,
    updatedAt: "2026-09-01T00:00:00.000Z",
    aiAnalyzedAt: "2026-08-31T00:00:00.000Z",
    pages: stored.pages.map(
      (
        /** @type {{id:string,name:string}} */ page,
        /** @type {number} */ index,
      ) => ({
        pageId: page.id,
        pageName: page.name,
        pageIndex: index,
        sourceDigest: "Private native source",
        translatedDigest: "Private native translation",
        summary: `Saved summary ${index}`,
        visualSummary: "Manual native scene",
        visualSummarySource: "manual",
        updatedAt: "2026-09-01T00:00:00.000Z",
      }),
    ),
  };
  memory.pages.push({ ...memory.pages[0], summary: "Last duplicate summary" });
  memory.pages.push({
    ...memory.pages[0],
    pageId: randomUUID(),
    summary: "Orphan preserved by Undo",
  });
  try {
    await writeFile(path, JSON.stringify(stored));
    await writeFile(memoryPath, JSON.stringify(memory));
    await exercisePageOrder(root, app, editing, chapterId, memoryPath);
    assert.deepEqual(JSON.parse(await readFile(memoryPath, "utf8")), memory);
    await unlink(memoryPath);
    await exercisePageOrder(root, app, editing, chapterId, memoryPath);
    await assert.rejects(readFile(memoryPath), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), stored);
    assert.deepEqual(
      await readFile(imagePath),
      await readFile(opened.pages[0].imagePath),
    );
    console.log(
      "PASS native page order -> reviewed memory reconciliation -> OS-encrypted record -> reconstructed exact Undo/Redo -> missing file and original preservation",
    );
  } finally {
    await writeFile(path, original);
    await unlink(imagePath);
  }
}

/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} chapterId @param {string} memoryPath */
async function exercisePageOrder(root, app, editing, chapterId, memoryPath) {
  const library = require(join(root, "out/main/library.js"));
  const before = await library.openChapter(chapterId);
  const intent = {
    kind: "reorder-pages",
    workId: before.workId,
    chapterId,
    pageIds: [...before.pageOrder].reverse(),
  };
  let client = await retainedClient(root, app, editing);
  try {
    const review = await client.call("preview_library_change", { intent });
    assert.deepEqual(review.after.pageIds, intent.pageIds);
    const input = {
      intent,
      snapshot: review.snapshot,
      planFingerprint: review.planFingerprint,
      requestId: randomUUID(),
    };
    const saved = await client.call("apply_library_change", input);
    assert.equal(saved.status, "saved");
    assert.deepEqual(
      (await library.openChapter(chapterId)).pages,
      [...before.pages].reverse(),
    );
    if (review.after.memory.present) {
      const memory = JSON.parse(await readFile(memoryPath, "utf8"));
      assert.equal(memory.pages.length, 2);
      assert.equal(memory.pages[1].summary, "Last duplicate summary");
      assert.equal(memory.pages[1].visualSummary, "Manual native scene");
      assert.equal(memory.pages[1].pageIndex, 1);
    }
    const recordPath = join(
      library.getLibraryRoot(),
      ".mcp-retained",
      saved.id,
      "record.json",
    );
    assert.doesNotMatch(
      await readFile(recordPath, "utf8"),
      /Private native|Manual native|Orphan preserved|Last duplicate/,
    );
    const after = await library.openChapter(chapterId);
    await client.close();
    client = await retainedClient(root, app, editing);
    for (const direction of ["undo", "redo", "undo"]) {
      const view = await client.call("get_library_change", { id: saved.id });
      assert.equal(direction === "undo" ? view.canUndo : view.canRedo, true);
      const action = {
        id: saved.id,
        snapshot: view.snapshot,
        requestId: randomUUID(),
      };
      assert.equal(
        (await client.call(`${direction}_library_change`, action)).status,
        "saved",
      );
      assert.deepEqual(
        await library.openChapter(chapterId),
        direction === "undo" ? before : after,
      );
      assert.equal(
        (await client.call(`${direction}_library_change`, action)).historical,
        true,
      );
      await client.close();
      client = await retainedClient(root, app, editing);
    }
    assert.equal(
      (await client.call("apply_library_change", input)).historical,
      true,
    );
    assert.deepEqual(await library.openChapter(chapterId), before);
    await client.call("discard_retained", { id: saved.id, confirm: true });
  } finally {
    await client.close();
  }
}
module.exports = { checkNativePageOrder };
