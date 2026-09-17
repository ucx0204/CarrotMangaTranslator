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
  assert.doesNotMatch(
    content[0].text,
    /dataUrl|imagePath|resource_link|beforeBlock|afterBlock/,
  );
  return JSON.parse(content[0].text);
}
/** @param {Invoke} invoke @param {string} chapterId @param {string} pageId */
async function pixels(invoke, chapterId, pageId) {
  const content = await invoke("carrot_render_page_preview", {
    chapterId,
    pageId,
  });
  const image = content.find((part) => part.type === "image");
  assert.ok(image?.data);
  return nativeImage
    .createFromBuffer(Buffer.from(image.data, "base64"))
    .toBitmap();
}
/** @param {Invoke} invoke @param {string} batchId */
async function settle(invoke, batchId) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const result = await call(invoke, "carrot_get_format_batch", { batchId });
    if (result.status !== "running") {
      assert.equal(result.status, "completed", JSON.stringify(result));
      return result;
    }
    await delay(20);
  }
  throw new Error("Native format batch did not complete");
}
/** @param {string} root @param {Invoke} invoke @param {string} chapterId */
async function checkNativeFormatBatch(root, invoke, chapterId) {
  const library = require(join(root, "out/main/library.js"));
  const chapter = await library.openChapter(chapterId);
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
    query: "arrived",
    field: "translation",
    format: {
      conditions: [{ field: "fontSizePx", operator: "gte", value: 1 }],
    },
  });
  assert.equal(search.total, 2);
  const plan = await call(invoke, "carrot_preview_format_batch", {
    chapterId,
    contextRevision: search.contextRevision,
    requestId: randomUUID(),
    reason: "AI repairs visually cramped text without changing dialogue",
    preserveManualFontSize: false,
    pages: search.matches.map((/** @type {any} */ hit) => ({
      pageId: hit.pageId,
      revision: hit.revision,
      edits: [
        {
          blockId: hit.blockId,
          fields: { fontSizePx: 36, letterSpacing: 0.08, textColor: "#bb0000" },
          renderRect: { x: 35, y: 180, w: 300, h: 120 },
          reason: "More readable space",
        },
      ],
    })),
  });
  assert.deepEqual(
    await library.openChapter(chapterId),
    chapter,
    "Preview must not write",
  );
  const request = { batchId: plan.batchId, requestId: randomUUID() };
  await call(invoke, "carrot_apply_format_batch", request);
  await settle(invoke, plan.batchId);
  const applied = await library.openChapter(chapterId);
  const after = await Promise.all(
    chapter.pages.map((/** @type {any} */ page) =>
      pixels(invoke, chapterId, page.id),
    ),
  );
  for (const [index, page] of applied.pages.entries()) {
    assert.notDeepEqual(after[index], before[index]);
    assert.equal(
      page.blocks[0].sourceText,
      chapter.pages[index].blocks[0].sourceText,
    );
    assert.equal(
      page.blocks[0].translatedText,
      chapter.pages[index].blocks[0].translatedText,
    );
    assert.deepEqual(page.blocks[0].bbox, chapter.pages[index].blocks[0].bbox);
    assert.deepEqual(page.blocks[1], chapter.pages[index].blocks[1]);
    assert.equal(page.blocks[0].fontSizeIntent, "manual");
  }
  for (const direction of ["undo", "redo", "undo"]) {
    await call(invoke, `carrot_${direction}_format_batch`, {
      batchId: plan.batchId,
      requestId: randomUUID(),
    });
    await settle(invoke, plan.batchId);
    const saved = await library.openChapter(chapterId);
    for (const [index, page] of saved.pages.entries()) {
      assert.deepEqual(
        page.blocks,
        (direction === "redo" ? applied : chapter).pages[index].blocks,
      );
      assert.deepEqual(page.blockOrder, chapter.pages[index].blockOrder);
      assert.deepEqual(await readFile(page.imagePath), originals[index]);
      assert.deepEqual(
        await pixels(invoke, chapterId, page.id),
        (direction === "redo" ? after : before)[index],
      );
    }
  }
  assert.equal(
    (await call(invoke, "carrot_apply_format_batch", request)).historical,
    true,
  );
  const restored = await library.openChapter(chapterId);
  assert.deepEqual(
    restored.pages.map((/** @type {any} */ page) => page.blocks),
    chapter.pages.map((/** @type {any} */ page) => page.blocks),
  );
  console.log(
    "PASS native style search -> multi-page format -> undo/redo -> exact block/pixel restoration; no text, source image or model change",
  );
}
module.exports = { checkNativeFormatBatch };
