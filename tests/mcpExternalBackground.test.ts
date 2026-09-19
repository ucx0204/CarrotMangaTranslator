import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createPageRevision } from "../src/shared/pageRevision";
import { externalImageFixture, externalPng } from "./mcpExternalImage.fixture";

function opaque(width: number, height: number) {
  const png = externalPng(width, height);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  return png;
}

it.each(["replace-background", "patch-background"] as const)(
  "publishes %s through native history, preserving originals and replaying after upload discard",
  async (kind) => {
    const f = await externalImageFixture();
    try {
      const before = (await f.snapshot()).pages[0];
      const original = await readFile(before.imagePath);
      const whole = kind === "replace-background";
      const png = opaque(whole ? before.width : 8, whole ? before.height : 6);
      const image = await f.upload(png);
      const plan = await f.preview(whole
        ? { kind: "replace-background", imageUploadId: image.uploadId }
        : { kind: "patch-background", imageUploadId: image.uploadId, rect: { x: 10, y: 10, w: 8, h: 6 } });
      expect(plan.canApply).toBe(true);
      const id = randomUUID();
      expect((await f.action(plan.batchId, "apply", id)).result.status).toBe("completed");
      const after = (await f.snapshot()).pages[0];
      const pixels = (await f.pixels(after.inpaintedImagePath)).data;
      expect(after.blocks).toEqual(before.blocks);
      expect(after.blockOrder).toEqual(before.blockOrder);
      expect(after.maskProvenance).toBe("retouch-updated");
      expect(after.inpaintMaskPath).toBeTruthy();
      if (whole) expect(pixels).toEqual(png.data);
      await f.invoke("carrot_discard_image_upload", { uploadId: image.uploadId });
      expect((await f.action(plan.batchId, "undo")).result.status).toBe("completed");
      expect(createPageRevision((await f.snapshot()).pages[0])).toBe(createPageRevision(before));
      expect((await f.action(plan.batchId, "apply", id)).receipt.structuredContent).toMatchObject({ historical: true });
      expect(createPageRevision((await f.snapshot()).pages[0])).toBe(createPageRevision(before));
      expect((await f.action(plan.batchId, "redo")).result.status).toBe("completed");
      expect((await f.pixels((await f.snapshot()).pages[0].inpaintedImagePath)).data).toEqual(pixels);
      expect(await readFile(before.imagePath)).toEqual(original);
      expect(f.acquireEngine).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
    } finally { await f.close(); }
  },
);

it("excludes fully protected and unchanged backgrounds without a save or native history", async () => {
  const f = await externalImageFixture();
  try {
    const before = await readFile(f.chapterPath);
    const page = (await f.snapshot()).pages[0];
    const unchanged = await f.upload(await f.pixels(page.inpaintedImagePath ?? page.imagePath));
    expect((await f.preview({ kind: "replace-background", imageUploadId: unchanged.uploadId })).canApply).toBe(false);
    const image = await f.upload(opaque(8, 6));
    const protection = await f.upload(externalPng(8, 6, true), "mask");
    const plan = await f.preview({ kind: "patch-background", imageUploadId: image.uploadId,
      protectedMaskUploadId: protection.uploadId, rect: { x: 0, y: 0, w: 8, h: 6 } });
    expect(plan.canApply).toBe(false);
    await expect(f.action(plan.batchId, "apply")).rejects.toThrow("No eligible pages");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.editing.notifySaved).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("keeps an acknowledged native image save undoable when UI notification fails", async () => {
  const f = await externalImageFixture();
  try {
    const before = (await f.snapshot()).pages[0];
    const image = await f.upload(opaque(8, 6));
    const plan = await f.preview({ kind: "patch-background", imageUploadId: image.uploadId,
      rect: { x: 10, y: 10, w: 8, h: 6 } });
    f.editing.notifySaved.mockImplementationOnce(() => { throw new Error("fixture notification failed"); });
    const result = (await f.action(plan.batchId, "apply")).result;
    expect(result.status).toBe("failed");
    expect(result.canUndo).toBe(true);
    expect((await f.snapshot()).pages[0].inpaintedImagePath).not.toBe(before.inpaintedImagePath);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("completed");
    expect(createPageRevision((await f.snapshot()).pages[0])).toBe(createPageRevision(before));
  } finally { await f.close(); }
});

it("refuses changed originals and subsequent user edits without overwriting page content", async () => {
  const f = await externalImageFixture();
  try {
    const before = (await f.snapshot()).pages[0];
    const image = await f.upload(opaque(8, 6));
    const plan = await f.preview({ kind: "patch-background", imageUploadId: image.uploadId,
      rect: { x: 10, y: 10, w: 8, h: 6 } });
    expect((await f.action(plan.batchId, "apply")).result.status).toBe("completed");
    const saved = JSON.parse(await readFile(f.chapterPath, "utf8"));
    saved.pages[0].blocks[0].translatedText = "later manual correction";
    await writeFile(f.chapterPath, JSON.stringify(saved));
    const changed = await readFile(f.chapterPath);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("failed");
    expect(await readFile(f.chapterPath)).toEqual(changed);
    const next = await f.upload(opaque(8, 6));
    const stale = await f.preview({ kind: "patch-background", imageUploadId: next.uploadId,
      rect: { x: 20, y: 20, w: 8, h: 6 } });
    await writeFile(before.imagePath, Buffer.from("changed outside the app"));
    expect((await f.action(stale.batchId, "apply")).result.status).toBe("failed");
    expect(await readFile(f.chapterPath)).toEqual(changed);
  } finally { await f.close(); }
});

it("cancels at native handoff without publishing and only releases this session's image references", async () => {
  const f = await externalImageFixture();
  let release: (() => void) | undefined;
  try {
    const before = await readFile(f.chapterPath);
    const asset = await f.upload(opaque(8, 6));
    const plan = await f.preview({ kind: "patch-background", imageUploadId: asset.uploadId,
      rect: { x: 10, y: 10, w: 8, h: 6 } });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    f.editing.assertWritable.mockImplementationOnce(async () => { entered(); await pending; });
    const requestId = randomUUID();
    await f.invoke("carrot_apply_external_image", { batchId: plan.batchId, requestId });
    await started;
    await f.invoke("carrot_cancel_external_image", { batchId: plan.batchId, requestId });
    release?.();
    expect((await f.action(plan.batchId, "apply", requestId)).result.status).toBe("cancelled");
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe("completed");
    const after = (await f.snapshot()).pages[0];
    const bytes = await readFile(after.inpaintedImagePath!);
    const releaseHistory = vi.spyOn(f.history, "releaseTransactions");
    await f.external.close();
    expect(releaseHistory).toHaveBeenCalledTimes(1);
    expect(releaseHistory.mock.calls[0][0]).toHaveLength(1);
    expect(await readFile(after.inpaintedImagePath!)).toEqual(bytes);
  } finally { release?.(); await f.close(); }
});
