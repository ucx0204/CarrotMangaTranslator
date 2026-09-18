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
  assert.ok(content[0]?.text);
  const result = JSON.parse(content[0].text);
  assert.ok(!result.error, JSON.stringify(result));
  assert.doesNotMatch(content[0].text, /imagePath|dataUrl|beforePath|transactionId/);
  return result;
}
/** @param {Invoke} invoke @param {string} batchId @param {string} direction */
async function act(invoke, batchId, direction) {
  await call(invoke, `carrot_${direction}_image_edit`, { batchId, requestId: randomUUID() });
  for (let i = 0; i < 500; i++) {
    const result = await call(invoke, "carrot_get_image_edit", { batchId });
    if (result.status !== "running") {
      assert.equal(result.status, "completed", JSON.stringify(result));
      return result;
    }
    await delay(20);
  }
  throw new Error("Native image edit did not settle");
}
/** @param {any} library @param {any} revisions @param {Invoke} invoke @param {string} chapterId @param {object} command */
async function preview(library, revisions, invoke, chapterId, command) {
  const saved = await library.readWorkContextForEdit(chapterId);
  const page = saved.chapter.pages[0];
  return call(invoke, "carrot_preview_image_edit", {
    chapterId, pageId: page.id, revision: revisions.createPageRevision(page),
    contextRevision: revisions.mcpContextRevision(saved), requestId: randomUUID(),
    reason: "Isolated native image-edit parity", command,
  });
}
/** @param {Buffer} before @param {Buffer} after @param {Buffer} mask */
function assertPixelBoundary(before, after, mask) {
  assert.equal(after.length, before.length);
  let changed = 0;
  for (let offset = 0; offset < before.length; offset += 4) {
    const a = before.subarray(offset, offset + 4), b = after.subarray(offset, offset + 4);
    // Native BGRA mask is white only where editing was authorized.
    if (mask[offset + 2] !== 255) assert.deepEqual(b, a);
    else if (!b.equals(a)) changed++;
  }
  assert.ok(changed > 0);
}
/** @param {string} path */
async function bitmap(path) {
  const image = nativeImage.createFromBuffer(await readFile(path));
  assert.equal(image.isEmpty(), false);
  return image.toBitmap();
}
/** @param {string} root @param {Invoke} invoke @param {string} chapterId */
async function checkNativeImageEdit(root, invoke, chapterId) {
  const library = require(join(root, "out/main/library.js"));
  const revisions = {
    ...require(join(root, "out/shared/pageRevision.js")),
    ...require(join(root, "out/shared/mcpContextEditing.js")),
  };
  const before = (await library.openChapter(chapterId)).pages[0];
  assert.ok(!before.inpaintedImagePath);
  const original = await readFile(before.imagePath), originalPixels = await bitmap(before.imagePath);
  const geometry = { kind: "rectangle", start: { x: 40, y: 40 }, end: { x: 90, y: 80 } };
  const protectedAreas = [{ kind: "ellipse", start: { x: 55, y: 50 }, end: { x: 70, y: 70 } }];
  const plan = await preview(library, revisions, invoke, chapterId,
    { kind: "paint", geometry, protectedAreas, color: "#134679" });
  const content = await invoke("carrot_get_image_edit_mask", { batchId: plan.batchId });
  const image = content.find((part) => part.type === "image");
  assert.ok(image?.data);
  const mask = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"));
  assert.deepEqual(mask.getSize(), { width: before.width, height: before.height });
  await act(invoke, plan.batchId, "apply");
  const painted = (await library.openChapter(chapterId)).pages[0];
  assert.deepEqual(painted.blocks, before.blocks);
  assertPixelBoundary(originalPixels, await bitmap(painted.inpaintedImagePath), mask.toBitmap());
  const sample = await call(invoke, "carrot_sample_page_color", {
    chapterId, pageId: painted.id, revision: revisions.createPageRevision(painted),
    image: "cleaned", x: 45, y: 45,
  });
  assert.equal(sample.color, "#134679");
  const restoration = await preview(library, revisions, invoke, chapterId,
    { kind: "restore", geometry, protectedAreas });
  await act(invoke, restoration.batchId, "apply");
  assert.deepEqual(await bitmap((await library.openChapter(chapterId)).pages[0].inpaintedImagePath), originalPixels);
  await act(invoke, restoration.batchId, "undo");
  for (const direction of ["undo", "redo", "undo"]) await act(invoke, plan.batchId, direction);
  const recovered = (await library.openChapter(chapterId)).pages[0];
  assert.equal(revisions.createPageRevision(recovered), revisions.createPageRevision(before));
  assert.deepEqual(await readFile(before.imagePath), original);
  console.log("PASS native image mask -> protected RGBA paint -> color sample -> original restore -> exact undo/redo (no model)");
}
module.exports = { checkNativeImageEdit };
