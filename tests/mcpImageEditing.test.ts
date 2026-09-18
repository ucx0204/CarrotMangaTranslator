import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { imageEditingFixture, brushCommand } from "./mcpImageEditing.fixture";
import { createPageRevision } from "../src/shared/pageRevision";

it("previews the exact protected mask without saving, preserves every outside RGBA pixel, and replays native history without inference", async () => {
  const f = await imageEditingFixture();
  try {
    const before = await f.snapshot();
    const chapterBytes = await readFile(f.chapterPath);
    const original = await f.pixels(before.pages[0].imagePath);
    const plan = await f.preview(brushCommand());
    const preview = await f.invoke("carrot_get_image_edit_mask", {
      batchId: plan.batchId,
    });
    const image = preview.content.find((item) => item.type === "image");
    if (!image || image.type !== "image") throw new Error("Missing mask PNG");
    const mask = PNG.sync.read(Buffer.from(image.data, "base64"));
    expect(mask.width).toBe(100);
    expect(
      mask.data.subarray((35 * 100 + 22) * 4, (35 * 100 + 22) * 4 + 4),
    ).toEqual(Buffer.from([255, 255, 255, 255]));
    expect(
      mask.data.subarray((35 * 100 + 27) * 4, (35 * 100 + 27) * 4 + 4),
    ).toEqual(Buffer.from([0, 0, 255, 255]));
    expect(await readFile(f.chapterPath)).toEqual(chapterBytes);
    expect(f.acquireEngine).not.toHaveBeenCalled();
    const applied = await f.action(plan.batchId, "apply");
    expect(applied.result.status).toBe("completed");
    expect(applied.result.changes[0].outcome?.changedPixels).toBeGreaterThan(0);
    const after = (await f.snapshot()).pages[0];
    const result = await f.pixels(after.inpaintedImagePath!);
    for (let i = 0; i < 10000; i++) {
      if (mask.data[i * 4] === 255) continue;
      expect(result.data.subarray(i * 4, i * 4 + 4)).toEqual(
        original.data.subarray(i * 4, i * 4 + 4),
      );
    }
    expect(after.blocks).toEqual(before.pages[0].blocks);
    expect(await readFile(after.imagePath)).toEqual(f.bytes);
    expect(f.inpaint).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
    const undone = (await f.snapshot()).pages[0];
    expect(undone.inpaintedImagePath).toBe(before.pages[0].inpaintedImagePath);
    expect(undone.inpaintMaskPath).toBe(before.pages[0].inpaintMaskPath);
    expect(undone.blocks).toEqual(before.pages[0].blocks);
    expect((await f.action(plan.batchId, "redo")).result.status).toBe(
      "completed",
    );
    expect((await f.snapshot()).pages[0].inpaintedImagePath).toBe(
      after.inpaintedImagePath,
    );
    expect(f.inpaint).toHaveBeenCalledOnce();
    expect(f.app.jobs.all).toEqual([]);
  } finally {
    await f.close();
  }
});

it("erases a native multi-block mask while preserving the unselected block and all text formatting", async () => {
  const f = await imageEditingFixture();
  try {
    const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
    stored.pages[0].blocks.push({
      ...stored.pages[0].blocks[0],
      id: "c",
      bbox: { x: 20, y: 30, w: 5, h: 5 },
    });
    await writeFile(f.chapterPath, JSON.stringify(stored));
    const before = await f.snapshot();
    const plan = await f.preview({
      kind: "erase-blocks",
      blockIds: ["a", "b"],
      expectedEngine: "lama-manga",
      allowAssetDownloads: true,
      protectedAreas: [],
    });
    expect(
      (await f.inspect(plan.batchId)).changes[0].mask.protectedPixels,
    ).toBe(25);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    const after = (await f.snapshot()).pages[0];
    const png = await f.pixels(after.inpaintedImagePath!);
    const original = await f.pixels(after.imagePath);
    for (let y = 30; y < 35; y++)
      for (let x = 20; x < 25; x++) {
        const i = (y * 100 + x) * 4;
        expect(png.data.subarray(i, i + 4)).toEqual(
          original.data.subarray(i, i + 4),
        );
      }
    expect(after.blocks).toEqual(before.pages[0].blocks);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
  } finally {
    await f.close();
  }
});

it.each(["rectangle", "ellipse", "stroke"] as const)(
  "paints and restores native %s geometry without any model call",
  async (kind) => {
    const f = await imageEditingFixture();
    try {
      const geometry =
        kind === "stroke"
          ? {
              kind,
              points: [
                { x: 20, y: 30 },
                { x: 30, y: 35 },
              ],
              radiusPx: 5,
            }
          : { kind, start: { x: 15, y: 25 }, end: { x: 35, y: 45 } };
      const paint = await f.preview({
        kind: "paint",
        geometry,
        color: "#123456",
        protectedAreas: [],
      });
      expect((await f.action(paint.batchId, "apply")).result.status).toBe(
        "completed",
      );
      const page = (await f.snapshot()).pages[0];
      const sample = (
        await f.invoke("carrot_sample_page_color", {
          chapterId: "chapter",
          pageId: "page",
          revision: createPageRevision(page),
          image: "cleaned",
          x: 25,
          y: 32,
        })
      ).structuredContent;
      expect(sample).toMatchObject({ color: "#123456" });
      const restore = await f.preview({
        kind: "restore",
        geometry,
        protectedAreas: [],
      });
      expect((await f.action(restore.batchId, "apply")).result.status).toBe(
        "completed",
      );
      const restored = (await f.snapshot()).pages[0];
      expect((await f.pixels(restored.inpaintedImagePath!)).data).toEqual(
        (await f.pixels(restored.imagePath)).data,
      );
      expect((await f.action(restore.batchId, "undo")).result.status).toBe(
        "completed",
      );
      expect((await f.snapshot()).pages[0].inpaintedImagePath).toBe(
        page.inpaintedImagePath,
      );
      expect(f.acquireEngine).not.toHaveBeenCalled();
      expect(f.getSettings).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it("does not reapply an old action receipt after undo and rejects mismatched preview request reuse", async () => {
  const f = await imageEditingFixture();
  try {
    const plan = await f.preview(brushCommand()),
      requestId = randomUUID();
    expect(
      (await f.action(plan.batchId, "apply", requestId)).result.status,
    ).toBe("completed");
    await f.action(plan.batchId, "undo");
    const again = await f.action(plan.batchId, "apply", requestId);
    expect(again.receipt.structuredContent).toMatchObject({
      historical: true,
      status: "already_started",
    });
    expect((await f.snapshot()).pages[0].inpaintedImagePath).toBeUndefined();
    await expect(
      f.invoke("carrot_preview_image_edit", {
        ...plan.request,
        reason: "different",
      }),
    ).rejects.toThrow(/requestId/);
    expect(f.inpaint).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
