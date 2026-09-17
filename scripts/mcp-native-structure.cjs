const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { nativeImage } = require("electron");
/** @typedef {(name: string, args: object) => Promise<Array<{type?: string, text?: string, data?: string}>>} Invoke */
/** @param {Invoke} invoke @param {string} name @param {object} args */
async function metadata(invoke, name, args) {
  const content = await invoke(name, args);
  assert.equal(content.length, 1, "Structure metadata never attaches files");
  assert.equal(content[0].type, "text");
  assert.ok(content[0].text);
  assert.doesNotMatch(content[0].text, /dataUrl|imagePath|resource_link/);
  return JSON.parse(content[0].text);
}
/** @param {Invoke} invoke @param {{chapterId: string, pageId: string}} target */
async function raster(invoke, target) {
  const content = await invoke("carrot_render_page_preview", target);
  const image = content.find((item) => item.type === "image");
  assert.ok(image?.data);
  return nativeImage
    .createFromBuffer(Buffer.from(image.data, "base64"))
    .toBitmap();
}
/** @param {import("../src/shared/libraryTypes").MangaPage} page */
function scenarios(page) {
  const first = page.blocks[0],
    second = page.blocks[1];
  const part = {
    sourceText: first.sourceText,
    translatedText: first.translatedText,
    sourceRect: { x: 40, y: 50, w: 65, h: 115 },
    renderRect: { x: 50, y: 50, w: 70, h: 115 },
  };
  return [
    { kind: "delete", blockId: first.id },
    {
      kind: "split",
      blockId: first.id,
      textPolicy: "preserve",
      parts: [
        { ...part, translatedText: "Hello" },
        {
          ...part,
          sourceText: "",
          translatedText: "MCP",
          sourceRect: { x: 105, y: 50, w: 65, h: 115 },
          renderRect: { x: 120, y: 50, w: 70, h: 115 },
        },
      ],
    },
    {
      kind: "merge",
      blockIds: [second.id, first.id],
      styleFromBlockId: first.id,
      textPolicy: "preserve",
      result: {
        ...part,
        sourceText: `${second.sourceText} ${first.sourceText}`,
        translatedText: `${second.translatedText} ${first.translatedText}`,
        sourceRect: { x: 40, y: 50, w: 285, h: 475 },
        renderRect: { x: 50, y: 50, w: 230, h: 390 },
      },
    },
  ];
}
/** Actual storage, page ownership and renderer; no inference stub is involved in structure editing.
 * @param {string} root @param {Invoke} invoke @param {string} chapterId @param {string} pageId */
async function checkNativeStructure(root, invoke, chapterId, pageId) {
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const target = { chapterId, pageId };
  const read = async () =>
    (await library.openChapter(chapterId)).pages.find(
      (/** @type {{id: string}} */ page) => page.id === pageId,
    );
  const before = await read();
  const original = await readFile(before.imagePath);
  const cleaned = before.inpaintedImagePath
    ? await readFile(before.inpaintedImagePath)
    : null;
  const rendered = await raster(invoke, target);
  for (const operation of scenarios(before)) {
    const plan = await metadata(invoke, "carrot_preview_block_structure_edit", {
      ...target,
      revision: createPageRevision(await read()),
      requestId: randomUUID(),
      reason:
        "The AI inspected a synthetic page and inferred a structure correction",
      operation,
    });
    assert.deepEqual(await read(), before, "Preview must not save");
    await roundtrip(invoke, target, plan, rendered);
    const restored = await read();
    assert.deepEqual(restored.blocks, before.blocks);
    assert.deepEqual(restored.blockOrder, before.blockOrder);
    assert.deepEqual(await readFile(restored.imagePath), original);
    if (cleaned)
      assert.deepEqual(await readFile(restored.inpaintedImagePath), cleaned);
    // Only ordinary save metadata may differ; the next scenario starts at that state.
    Object.assign(before, restored);
  }
  console.log(
    "PASS native structure split/merge/delete apply/undo/redo, actual pixel restoration, stable IDs, original and cleaned bytes preserved; no inference",
  );
}
/** @param {Invoke} invoke @param {{chapterId: string, pageId: string}} target @param {any} plan @param {Buffer} before */
async function roundtrip(invoke, target, plan, before) {
  const applyRequest = {
    editId: plan.editId,
    revision: plan.currentRevision,
    requestId: randomUUID(),
  };
  const applied = await metadata(
    invoke,
    "carrot_apply_block_structure_edit",
    applyRequest,
  );
  assert.equal(applied.pagesChanged, 1);
  const pixels = await raster(invoke, target);
  assert.notDeepEqual(
    pixels,
    before,
    "Structure editing should affect this fixture rendering",
  );
  const blocks = await metadata(invoke, "carrot_get_page_blocks", target);
  assert.deepEqual(blocks.effectiveBlockOrder, plan.afterBlockOrder);
  await assert.rejects(() =>
    invoke("carrot_undo_block_structure_edit", {
      ...applyRequest,
      requestId: randomUUID(),
    }),
  );
  const undoRequest = {
    ...applyRequest,
    revision: applied.revision,
    requestId: randomUUID(),
  };
  const undone = await metadata(
    invoke,
    "carrot_undo_block_structure_edit",
    undoRequest,
  );
  assert.deepEqual(await raster(invoke, target), before);
  const redone = await metadata(invoke, "carrot_redo_block_structure_edit", {
    ...applyRequest,
    revision: undone.revision,
    requestId: randomUUID(),
  });
  assert.deepEqual(await raster(invoke, target), pixels);
  const replay = await metadata(
    invoke,
    "carrot_undo_block_structure_edit",
    undoRequest,
  );
  assert.equal(replay.pagesChanged, 0);
  assert.equal(replay.historical, true);
  assert.deepEqual(await raster(invoke, target), pixels);
  await metadata(invoke, "carrot_undo_block_structure_edit", {
    ...applyRequest,
    revision: redone.revision,
    requestId: randomUUID(),
  });
  assert.deepEqual(await raster(invoke, target), before);
}
module.exports = { checkNativeStructure };
