import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { externalImageFixture, externalPng } from "./mcpExternalImage.fixture";

it("requires explicit existing-layer replacement and preserves unrelated block fields", async () => {
  const f = await externalImageFixture();
  try {
    const page = (await f.snapshot()).pages[0], first = await f.upload(externalPng());
    const command = { kind: "lettering" as const, imageUploadId: first.uploadId, blockId: page.blocks[0].id,
      replaceExisting: false, existingDecorations: "preserve" as const };
    const plan = await f.preview(command);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe("completed");
    const after = (await f.snapshot()).pages[0];
    const png = externalPng(); png.data[0] = 250;
    const second = await f.upload(png);
    await expect(f.preview({ ...command, imageUploadId: second.uploadId })).rejects.toThrow("replaceExisting");
    const replacement = await f.preview({ ...command, imageUploadId: second.uploadId, replaceExisting: true });
    expect((await f.action(replacement.batchId, "apply")).result.status).toBe("completed");
    expect((await f.action(replacement.batchId, "undo")).result.status).toBe("completed");
    expect((await f.snapshot()).pages[0].blocks).toEqual(after.blocks);
    expect(f.acquireEngine).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
it("keeps empty masks unapplied and rejects partially transparent background pixels", async () => {
  const f = await externalImageFixture();
  try {
    const page = (await f.snapshot()).pages[0], original = await readFile(f.chapterPath);
    const png = externalPng(), empty = externalPng(8, 6, true);
    for (let i = 0; i < empty.data.length; i += 4) empty.data.fill(0, i, i + 3);
    const image = await f.upload(png), mask = await f.upload(empty, "mask");
    const plan = await f.preview({ kind: "lettering", imageUploadId: image.uploadId, maskUploadId: mask.uploadId,
      blockId: page.blocks[0].id, replaceExisting: false, existingDecorations: "clear" });
    expect(plan.canApply).toBe(false);
    await expect(f.preview({ kind: "patch-background", imageUploadId: image.uploadId, rect: { x: 0, y: 0, w: 8, h: 6 } })).rejects.toThrow("must be opaque");
    expect(await readFile(f.chapterPath)).toEqual(original);
  } finally { await f.close(); }
});
it("cancels a pending native layer commit without a save and rejects stale cancellation IDs", async () => {
  const f = await externalImageFixture();
  let release!: () => void;
  try {
    const original = await readFile(f.chapterPath), page = (await f.snapshot()).pages[0];
    const image = await f.upload(externalPng());
    const plan = await f.preview({ kind: "lettering", imageUploadId: image.uploadId, blockId: page.blocks[0].id,
      replaceExisting: false, existingDecorations: "preserve" });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    f.editing.assertWritable.mockImplementationOnce(async () => { entered(); await pending; });
    const requestId = randomUUID();
    await f.invoke("carrot_apply_external_image", { batchId: plan.batchId, requestId });
    await started;
    await expect(f.invoke("carrot_cancel_external_image", { batchId: plan.batchId, requestId: randomUUID() })).rejects.toThrow("currently inspected");
    await f.invoke("carrot_cancel_external_image", { batchId: plan.batchId, requestId });
    release();
    const result = await f.action(plan.batchId, "apply", requestId);
    expect(result.result.status).toBe("cancelled");
    expect(await readFile(f.chapterPath)).toEqual(original);
  } finally { release?.(); await f.close(); }
});
it("blocks redacted candidate images and refuses access after session shutdown", async () => {
  const f = await externalImageFixture();
  try {
    const image = await f.upload(externalPng()), page = (await f.snapshot()).pages[0];
    const plan = await f.preview({ kind: "lettering", imageUploadId: image.uploadId, blockId: page.blocks[0].id,
      replaceExisting: false, existingDecorations: "preserve" });
    const redaction = await import("../src/main/imageRedactionStore");
    await redaction.setImageRedactionEnabled(true, f.env.root);
    await expect(f.invoke("carrot_get_external_image_preview", { batchId: plan.batchId })).rejects.toThrow("redaction");
    f.external.stop();
    await expect(f.invoke("carrot_get_image_upload", { uploadId: image.uploadId })).rejects.toThrow();
    expect(f.editing.notifySaved).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
