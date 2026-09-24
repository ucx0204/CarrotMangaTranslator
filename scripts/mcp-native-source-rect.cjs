const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { nativeImage } = require("electron");

/** @typedef {{type?: string, text?: string, data?: string}} Content */
/** @typedef {(name: string, args: object) => Promise<Content[]>} Invoke */
/** @param {Content[]} content */
function metadata(content) {
  assert.equal(content.length, 1, "Source edits must never attach files");
  assert.equal(content[0].type, "text");
  assert.ok(content[0].text);
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
/** Exercise the real app writer and renderer on the isolated native fixture.
 * No model is loaded and no user library is selected.
 * @param {string} root @param {Invoke} invoke @param {string} chapterId @param {string} pageId */
async function checkNativeSourceRect(root, invoke, chapterId, pageId) {
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const target = { chapterId, pageId };
  const before = (await library.openChapter(chapterId)).pages.find(
    (/** @type {{id: string}} */ page) => page.id === pageId,
  );
  assert.ok(before);
  const original = await readFile(before.imagePath);
  const rendered = await raster(invoke, target);
  const request = {
    ...target,
    blockId: before.blocks[0].id,
    revision: createPageRevision(before),
    sourceRect: { x: 42.25, y: 52.5, w: 134.5, h: 119.25 },
  };
  const result = metadata(
    await invoke("carrot_update_block_source_rect", request),
  );
  assert.equal(result.status, "saved");
  assert.deepEqual(result.sourceRect, request.sourceRect);
  assert.equal(JSON.stringify(result).includes(root), false);
  const changed = (await library.openChapter(chapterId)).pages[0];
  assert.deepEqual(changed.blocks, [
    {
      ...before.blocks[0],
      bbox: result.sourceBbox,
      bboxSpace: "normalized_1000",
    },
    ...before.blocks.slice(1),
  ]);
  assert.deepEqual(changed.blockOrder, before.blockOrder);
  assert.equal(changed.inpaintedImagePath, before.inpaintedImagePath);
  assert.equal(changed.inpaintMaskPath, before.inpaintMaskPath);
  assert.deepEqual(await readFile(before.imagePath), original);
  assert.deepEqual(await raster(invoke, target), rendered);
  await assert.rejects(() =>
    invoke("carrot_update_block_source_rect", request),
  );
  const noOp = metadata(
    await invoke("carrot_update_block_source_rect", {
      ...request,
      revision: result.revision,
    }),
  );
  assert.equal(noOp.changed, false);
  assert.equal(noOp.status, "already_applied");
  await assert.rejects(() =>
    invoke("carrot_update_block_source_rect", {
      ...request,
      revision: result.revision,
      sourceRect: { x: before.width - 1, y: 0, w: 2, h: 10 },
    }),
  );
  const restored = metadata(
    await invoke("carrot_update_block_source_rect", {
      ...request,
      revision: result.revision,
      sourceRect: result.previousSourceRect,
    }),
  );
  assert.equal(restored.status, "saved");
  const final = (await library.openChapter(chapterId)).pages[0];
  assert.deepEqual(final.blocks, before.blocks);
  assert.deepEqual(await raster(invoke, target), rendered);
  assert.deepEqual(await readFile(before.imagePath), original);
  console.log(
    "PASS native source rectangle edit/readback/restore preserves text, rendering, original bytes and untouched blocks; stale and off-page edits rejected",
  );
}
module.exports = { checkNativeSourceRect };
