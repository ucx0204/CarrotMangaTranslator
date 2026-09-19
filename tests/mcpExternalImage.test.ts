import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { externalImageFixture, externalPng } from "./mcpExternalImage.fixture";

it("stores only the reviewed native lettering field and exactly undoes/redoes after staging discard", async () => {
  const f = await externalImageFixture();
  try {
    const before = (await f.snapshot()).pages[0],
      original = await readFile(before.imagePath);
    const asset = await f.upload(externalPng());
    const plan = await f.preview({
      kind: "lettering",
      blockId: before.blocks[0].id,
      imageUploadId: asset.uploadId,
      replaceExisting: false,
      existingDecorations: "preserve",
    });
    expect((await f.inspect(plan.batchId)).canApply).toBe(true);
    const requestId = randomUUID();
    expect(
      (await f.action(plan.batchId, "apply", requestId)).result.status,
    ).toBe("completed");
    const after = (await f.snapshot()).pages[0];
    expect(after.blocks[0].generatedLettering?.dataUrl).toMatch(
      /^data:image\/png;base64,/,
    );
    const { generatedLettering: image, ...rest } = after.blocks[0];
    expect(rest).toEqual(before.blocks[0]);
    expect(image?.translatedText).toBe(before.blocks[0].translatedText);
    expect(after.blocks.slice(1)).toEqual(before.blocks.slice(1));
    expect(after.inpaintedImagePath).toBe(before.inpaintedImagePath);
    await f.invoke("carrot_discard_image_upload", { uploadId: asset.uploadId });
    expect((await f.action(plan.batchId, "undo")).result.status).toBe(
      "completed",
    );
    expect((await f.snapshot()).pages[0].blocks).toEqual(before.blocks);
    const replay = await f.action(plan.batchId, "apply", requestId);
    expect(replay.receipt.structuredContent).toMatchObject({
      historical: true,
    });
    expect((await f.snapshot()).pages[0].blocks).toEqual(before.blocks);
    expect((await f.action(plan.batchId, "redo")).result.status).toBe(
      "completed",
    );
    expect((await f.snapshot()).pages[0].blocks).toEqual(after.blocks);
    expect(await readFile(before.imagePath)).toEqual(original);
    expect(f.acquireEngine).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("uses explicit binary and protected masks for layer alpha without inferring background removal", async () => {
  const f = await externalImageFixture();
  try {
    const png = externalPng(),
      selection = externalPng(8, 6, true),
      protection = externalPng(8, 6, true);
    for (let i = 0; i < protection.data.length; i += 4)
      protection.data.fill(0, i, i + 3);
    selection.data.fill(0, 0, 3);
    protection.data.fill(255, 4, 7);
    const image = await f.upload(png),
      mask = await f.upload(selection, "mask"),
      protectedMask = await f.upload(protection, "mask");
    const before = (await f.snapshot()).pages[0];
    const plan = await f.preview({
      kind: "lettering",
      blockId: before.blocks[0].id,
      imageUploadId: image.uploadId,
      maskUploadId: mask.uploadId,
      protectedMaskUploadId: protectedMask.uploadId,
      replaceExisting: false,
      existingDecorations: "preserve",
    });
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    const url = (await f.snapshot()).pages[0].blocks[0].generatedLettering
      ?.dataUrl;
    if (!url) throw new Error("Missing native image layer");
    const output = PNG.sync.read(Buffer.from(url.split(",")[1], "base64"));
    expect(output.data.subarray(0, 8)).toEqual(Buffer.alloc(8));
    expect(output.data.subarray(8)).toEqual(png.data.subarray(8));
  } finally {
    await f.close();
  }
});
it("returns exact protected patch previews but never claims unfinished background publication", async () => {
  const f = await externalImageFixture();
  try {
    const before = await readFile(f.chapterPath),
      page = (await f.snapshot()).pages[0];
    const png = externalPng();
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
    const protection = externalPng(8, 6, true);
    for (let i = 0; i < protection.data.length; i += 4)
      protection.data.fill(0, i, i + 3);
    protection.data.fill(255, 0, 3);
    const image = await f.upload(png),
      mask = await f.upload(protection, "mask");
    const plan = await f.preview({
      kind: "patch-background",
      imageUploadId: image.uploadId,
      protectedMaskUploadId: mask.uploadId,
      rect: { x: 10, y: 10, w: 8, h: 6 },
    });
    expect(plan.canApply).toBe(false);
    const view = await f.inspect(plan.batchId);
    expect(view.changes[0].excludedReason).toBe(
      "background_application_not_connected",
    );
    const preview = await f.invoke("carrot_get_external_image_preview", {
      batchId: plan.batchId,
    });
    const imagePart = preview.content.find((part) => part.type === "image");
    if (!imagePart || imagePart.type !== "image")
      throw new Error("Missing candidate PNG");
    const candidate = PNG.sync.read(Buffer.from(imagePart.data, "base64"));
    const source = PNG.sync.read(
      await readFile(page.inpaintedImagePath ?? page.imagePath),
    );
    for (let y = 0; y < page.height; y++)
      for (let x = 0; x < page.width; x++) {
        const at = (y * page.width + x) * 4;
        const selected =
          x >= 10 && x < 18 && y >= 10 && y < 16 && !(x === 10 && y === 10);
        expect(candidate.data.subarray(at, at + 4)).toEqual(
          selected
            ? Buffer.from([19, 70, 121, 255])
            : source.data.subarray(at, at + 4),
        );
      }
    await expect(f.action(plan.batchId, "apply")).rejects.toThrow(
      "No eligible pages",
    );
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
it("rejects foreign, incomplete, mismatched-size and wrongly targeted uploads without saving", async () => {
  const f = await externalImageFixture();
  try {
    const before = await readFile(f.chapterPath),
      page = (await f.snapshot()).pages[0];
    const image = await f.upload(externalPng()),
      mask = await f.upload(externalPng(7, 6, true), "mask");
    await expect(
      f.invoke(
        "carrot_get_image_upload",
        { uploadId: image.uploadId },
        f.auth("other"),
      ),
    ).rejects.toThrow("Owned image upload");
    await expect(
      f.preview({
        kind: "lettering",
        imageUploadId: image.uploadId,
        blockId: page.blocks[0].id,
        maskUploadId: mask.uploadId,
        replaceExisting: false,
        existingDecorations: "preserve",
      }),
    ).rejects.toThrow("identical dimensions");
    await expect(
      f.preview({
        kind: "patch-background",
        imageUploadId: image.uploadId,
        rect: { x: 0, y: 0, w: 9, h: 6 },
      }),
    ).rejects.toThrow("exactly match");
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
it("rejects originals changed after reservation and does not overwrite a later edit during undo", async () => {
  const f = await externalImageFixture();
  try {
    const before = (await f.snapshot()).pages[0],
      image = await f.upload(externalPng());
    const plan = await f.preview({
      kind: "lettering",
      imageUploadId: image.uploadId,
      blockId: before.blocks[0].id,
      replaceExisting: false,
      existingDecorations: "preserve",
    });
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    const stored = JSON.parse(await readFile(f.chapterPath, "utf8"));
    stored.pages[0].blocks[0].translatedText = "later user edit";
    await writeFile(f.chapterPath, JSON.stringify(stored));
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("failed");
    expect((await f.snapshot()).pages[0].blocks[0].translatedText).toBe(
      "later user edit",
    );
    const next = await f.upload(externalPng());
    const original = PNG.sync.read(await readFile(before.imagePath));
    original.data[0] ^= 1;
    await writeFile(before.imagePath, PNG.sync.write(original));
    await expect(
      f.preview({
        kind: "lettering",
        imageUploadId: next.uploadId,
        blockId: before.blocks[0].id,
        replaceExisting: true,
        existingDecorations: "preserve",
      }),
    ).rejects.toThrow("differs from upload");
  } finally {
    await f.close();
  }
});
