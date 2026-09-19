const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { nativeImage } = require("electron");

/** @typedef {{chapterId: string, pageId: string, revision: string, contextRevision: string}} Binding */
/** @typedef {(name: string, args: object) => Promise<Array<{text?: string}>>} Invoke */
/** @param {Invoke} invoke */
function externalClient(invoke) {
  /** @param {string} name @param {object} args */
  const call = async (name, args) => {
    const parts = await invoke(`carrot_${name}`, args);
    assert.ok(parts[0]?.text, `Missing ${name} metadata`);
    const value = JSON.parse(parts[0].text);
    assert.ok(!value.error, parts[0].text);
    assert.doesNotMatch(parts[0].text, /dataUrl|imagePath|transactionId/);
    return value;
  };
  /** @param {string} batchId @param {string} action */
  const act = async (batchId, action) => {
    await call(`${action}_external_image`, {
      batchId,
      requestId: randomUUID(),
    });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = await call("get_external_image", { batchId });
      if (value.status !== "running") {
        assert.equal(value.status, "completed", JSON.stringify(value));
        return;
      }
      await pause(25);
    }
    throw new Error("External image action did not finish");
  };
  /** @param {Binding} binding @param {Buffer} bytes @param {string} purpose */
  const upload = async (binding, bytes, purpose) => {
    const size = nativeImage.createFromBuffer(bytes).getSize();
    const receipt = await call("begin_image_upload", {
      ...binding,
      ...size,
      purpose,
      mimeType: "image/png",
      requestId: randomUUID(),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    for (let offset = 0; offset < bytes.length; offset += receipt.chunkBytes)
      await call("write_image_upload", {
        uploadId: receipt.uploadId,
        offset,
        data: bytes
          .subarray(offset, offset + receipt.chunkBytes)
          .toString("base64"),
      });
    const ready = await call("finish_image_upload", {
      uploadId: receipt.uploadId,
    });
    assert.equal(ready.status, "ready");
    assert.equal(ready.receivedBytes, bytes.length);
    return ready.uploadId;
  };
  return { call, act, upload };
}

/** @param {string} root @param {Invoke} invoke @param {string} chapterId */
async function checkNativeExternalImage(root, invoke, chapterId) {
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const { mcpContextRevision } = require(
    join(root, "out/shared/mcpContextEditing.js"),
  );
  const read = async () => (await library.openChapter(chapterId)).pages[0];
  const binding = async () => {
    const saved = await library.readWorkContextForEdit(chapterId);
    return {
      chapterId,
      pageId: saved.chapter.pages[0].id,
      revision: createPageRevision(saved.chapter.pages[0]),
      contextRevision: mcpContextRevision(saved),
    };
  };
  const client = externalClient(invoke);
  const before = await read();
  const original = await readFile(before.imagePath);
  const current = await readFile(before.inpaintedImagePath ?? before.imagePath);
  await checkBackground(client, await binding(), current);
  assert.deepEqual((await read()).blocks, before.blocks);
  assert.equal(createPageRevision(await read()), createPageRevision(before));
  const imageUploadId = await client.upload(
    await binding(),
    patchPng(false),
    "image",
  );
  const plan = await client.call("preview_external_image", {
    ...(await binding()),
    requestId: randomUUID(),
    reason: "Isolated native external lettering",
    command: { kind: "lettering", imageUploadId, blockId: before.blocks[0].id },
  });
  await client.act(plan.batchId, "apply");
  const layered = await read();
  assert.ok(
    layered.blocks[0].generatedLettering?.dataUrl.startsWith(
      "data:image/png;base64,",
    ),
  );
  const { generatedLettering: _layer, ...unchanged } = layered.blocks[0];
  assert.deepEqual(unchanged, before.blocks[0]);
  assert.deepEqual(layered.blocks.slice(1), before.blocks.slice(1));
  await client.call("discard_image_upload", { uploadId: imageUploadId });
  for (const action of ["undo", "redo", "undo"])
    await client.act(plan.batchId, action);
  assert.deepEqual((await read()).blocks, before.blocks);
  assert.deepEqual(await readFile(before.imagePath), original);
  console.log(
    "PASS native external PNG chunks -> protected background pixels -> image history -> lettering layer -> exact recovery without models",
  );
}

/** @param {ReturnType<typeof externalClient>} client @param {Binding} binding @param {Buffer} original */
async function checkBackground(client, binding, original) {
  const imageUploadId = await client.upload(binding, patchPng(false), "image");
  const protectedMaskUploadId = await client.upload(
    binding,
    patchPng(true),
    "mask",
  );
  const plan = await client.call("preview_external_image", {
    ...binding,
    requestId: randomUUID(),
    reason: "Isolated native external background",
    command: {
      kind: "patch-background",
      imageUploadId,
      protectedMaskUploadId,
      rect: { x: 10, y: 10, w: 8, h: 6 },
    },
  });
  assert.equal(plan.canApply, true);
  await client.act(plan.batchId, "apply");
  // Color reading is a native page operation, while the output preview is bound
  // to the original reservation and intentionally cannot be reused after a save.
  const inspected = await client.call("get_external_image", {
    batchId: plan.batchId,
  });
  const page = inspected.pages[0];
  const base = {
    chapterId: binding.chapterId,
    pageId: binding.pageId,
    revision: page.expectedRevision,
    image: "cleaned",
  };
  const changed = await client.call("sample_page_color", {
    ...base,
    x: 11,
    y: 10,
  });
  assert.equal(changed.color, "#134679");
  const preserved = await client.call("sample_page_color", {
    ...base,
    x: 10,
    y: 10,
  });
  const source = nativeImage.createFromBuffer(original);
  const offset = (10 * source.getSize().width + 10) * 4;
  const bgra = source.toBitmap().subarray(offset, offset + 4);
  assert.equal(
    preserved.color,
    `#${[bgra[2], bgra[1], bgra[0]].map((v) => v.toString(16).padStart(2, "0")).join("")}`,
  );
  await client.call("discard_image_upload", { uploadId: imageUploadId });
  await client.call("discard_image_upload", {
    uploadId: protectedMaskUploadId,
  });
  for (const action of ["undo", "redo", "undo"])
    await client.act(plan.batchId, action);
}
/** @param {boolean} mask */
function patchPng(mask) {
  const bitmap = Buffer.alloc(8 * 6 * 4);
  for (let i = 0; i < bitmap.length; i += 4) {
    bitmap[i] = mask ? 0 : 121;
    bitmap[i + 1] = mask ? 0 : 70;
    bitmap[i + 2] = mask ? 0 : 19;
    bitmap[i + 3] = 255;
  }
  if (mask) bitmap.fill(255, 0, 4);
  return nativeImage.createFromBitmap(bitmap, { width: 8, height: 6 }).toPNG();
}
module.exports = { checkNativeExternalImage };
