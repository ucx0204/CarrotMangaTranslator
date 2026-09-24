const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { nativeImage } = require("electron");
/** @typedef {(name: string, args: object) => Promise<Array<{type?: string, text?: string, data?: string}>>} Invoke */
/** @param {Invoke} invoke @param {string} name @param {object} args */
async function call(invoke, name, args) {
  const content = await invoke(name, args);
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  assert.ok(content[0].text);
  assert.doesNotMatch(content[0].text, /dataUrl|imagePath|resource_link/);
  return JSON.parse(content[0].text);
}
/** @param {Invoke} invoke @param {string} batchId */
async function settle(invoke, batchId) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await call(invoke, "carrot_get_translation_batch", {
      batchId,
    });
    if (result.status !== "running") {
      assert.equal(result.status, "completed", JSON.stringify(result));
      return result;
    }
    await delay(20);
  }
  throw new Error("Native text batch did not complete");
}
/** @param {Invoke} invoke @param {string} chapterId @param {string} pageId */
async function pixels(invoke, chapterId, pageId) {
  const content = await invoke("carrot_render_page_preview", {
    chapterId,
    pageId,
  });
  const image = content.find((item) => item.type === "image");
  assert.ok(image?.data);
  return nativeImage
    .createFromBuffer(Buffer.from(image.data, "base64"))
    .toBitmap();
}
/** @param {string} root @param {Invoke} invoke @param {string} sourcePath */
async function checkNativeTextBatch(root, invoke, sourcePath) {
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const { mcpContextRevision } = require(
    join(root, "out/shared/mcpContextEditing.js"),
  );
  const imported = await library.createImport({
    preview: {
      mode: "single",
      sourceKind: "images",
      suggestedWorkTitle: "Text batch fixture",
      chapters: [
        {
          draftId: "batch",
          title: "Text batch",
          sourceKind: "images",
          pages: ["one.png", "two.png"].map((name) => ({
            name,
            sourcePath,
            sourceKind: "file",
          })),
        },
      ],
    },
    target: { mode: "new", title: "Text batch fixture" },
    selections: [{ draftId: "batch", title: "Text batch", enabled: true }],
  });
  const chapterId = imported.chapterIds[0];
  let chapter = await library.openChapter(chapterId);
  for (const [index, page] of chapter.pages.entries())
    await call(invoke, "carrot_create_page_blocks", {
      chapterId,
      pageId: page.id,
      revision: createPageRevision(page),
      requestId: randomUUID(),
      blocks: [
        {
          key: "name",
          sourceText: "リオが来た。",
          translatedText: index ? "RIO has arrived." : "Ryo has arrived.",
          sourceRect: { x: 40, y: 50, w: 130, h: 115 },
          renderRect: { x: 50, y: 180, w: 250, h: 80 },
        },
        {
          key: "untouched",
          sourceText: "そのまま",
          translatedText: "Keep this text",
          sourceRect: { x: 40, y: 400, w: 140, h: 40 },
          renderRect: { x: 50, y: 400, w: 250, h: 80 },
        },
      ],
    });
  chapter = await library.openChapter(chapterId);
  const originals = await Promise.all(
    chapter.pages.map((/** @type {any} */ page) => readFile(page.imagePath)),
  );
  const before = await Promise.all(
    chapter.pages.map((/** @type {any} */ page) =>
      pixels(invoke, chapterId, page.id),
    ),
  );
  const search = await call(invoke, "carrot_search_chapter_text", {
    chapterId,
    mode: "search",
    query: "R",
    field: "translation",
    limit: 1,
  });
  assert.equal(search.total, 2);
  const next = await call(invoke, "carrot_search_chapter_text", {
    chapterId,
    mode: "search",
    query: "R",
    field: "translation",
    limit: 1,
    snapshot: search.snapshot,
    offset: search.nextOffset,
  });
  const targets = [...search.matches, ...next.matches];
  const context = await library.readWorkContextForEdit(chapterId);
  const plan = await call(invoke, "carrot_preview_translation_batch", {
    chapterId,
    contextRevision: mcpContextRevision(context),
    requestId: randomUUID(),
    reason: "Unify character name after reading candidate dialogue",
    pages: targets.map((/** @type {any} */ hit) => ({
      pageId: hit.pageId,
      revision: hit.revision,
      edits: [
        {
          blockId: hit.blockId,
          translatedText: "Rio arrived.",
          reason: "The same intended character",
        },
      ],
    })),
  });
  assert.deepEqual(
    await library.openChapter(chapterId),
    chapter,
    "Preview cannot save",
  );
  const request = { batchId: plan.batchId, requestId: randomUUID() };
  await call(invoke, "carrot_apply_translation_batch", request);
  await settle(invoke, plan.batchId);
  const after = await Promise.all(
    chapter.pages.map((/** @type {any} */ page) =>
      pixels(invoke, chapterId, page.id),
    ),
  );
  for (let index = 0; index < before.length; index++)
    assert.notDeepEqual(after[index], before[index]);
  await call(invoke, "carrot_undo_translation_batch", {
    batchId: plan.batchId,
    requestId: randomUUID(),
  });
  await settle(invoke, plan.batchId);
  assert.equal(
    (await call(invoke, "carrot_apply_translation_batch", request)).historical,
    true,
  );
  await call(invoke, "carrot_redo_translation_batch", {
    batchId: plan.batchId,
    requestId: randomUUID(),
  });
  await settle(invoke, plan.batchId);
  for (const [index, page] of chapter.pages.entries())
    assert.deepEqual(await pixels(invoke, chapterId, page.id), after[index]);
  await call(invoke, "carrot_undo_translation_batch", {
    batchId: plan.batchId,
    requestId: randomUUID(),
  });
  await settle(invoke, plan.batchId);
  const restored = await library.openChapter(chapterId);
  for (const [index, page] of restored.pages.entries()) {
    assert.deepEqual(page.blocks, chapter.pages[index].blocks);
    assert.deepEqual(page.blockOrder, chapter.pages[index].blockOrder);
    assert.deepEqual(await readFile(page.imagePath), originals[index]);
    assert.deepEqual(await pixels(invoke, chapterId, page.id), before[index]);
  }
  console.log(
    "PASS native chapter text search -> multi-page translation batch -> undo/redo -> exact rendered restoration, no model or source mutation",
  );
  return chapterId;
}
module.exports = { checkNativeTextBatch };
