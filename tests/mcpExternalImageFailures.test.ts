import * as fs from "node:fs/promises";
import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
import { externalImageFixture, externalPng } from "./mcpExternalImage.fixture";

it.each(["empty", "wrong-size"] as const)(
  "rejects a validated background whose native decoder returns %s without publishing",
  async (kind) => {
    const f = await externalImageFixture();
    const { nativeImage } = await import("electron");
    const decode = nativeImage.createFromBuffer;
    const spy = vi.spyOn(nativeImage, "createFromBuffer");
    try {
      const before = await fs.readFile(f.chapterPath);
      const png = externalPng();
      for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
      const image = await f.upload(png);
      const bad =
        kind === "empty"
          ? Buffer.from("invalid native image")
          : PNG.sync.write(externalPng(1, 1));
      spy.mockImplementation((bytes, options) =>
        decode(bytes.equals(image.bytes) ? bad : bytes, options),
      );
      await expect(
        f.preview({
          kind: "patch-background",
          imageUploadId: image.uploadId,
          rect: { x: 10, y: 10, w: 8, h: 6 },
        }),
      ).rejects.toThrow(/Native .*dimensions/);
      expect(await fs.readFile(f.chapterPath)).toEqual(before);
      expect(f.editing.notifySaved).not.toHaveBeenCalled();
      expect(f.acquireEngine).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await f.close();
    }
  },
);

it("surfaces staging cleanup failure while still releasing native history and preserving saved images", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const remove = actual.rm;
  const spy = vi.fn<typeof actual.rm>((path, options) => remove(path, options));
  vi.doMock("node:fs/promises", () => ({ ...actual, rm: spy }));
  const f = await externalImageFixture();
  try {
    const png = externalPng();
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
    const image = await f.upload(png);
    const plan = await f.preview({
      kind: "patch-background",
      imageUploadId: image.uploadId,
      rect: { x: 10, y: 10, w: 8, h: 6 },
    });
    expect((await f.action(plan.batchId, "apply")).result.status).toBe(
      "completed",
    );
    const page = (await f.snapshot()).pages[0];
    if (!page.inpaintedImagePath) throw new Error("Expected saved image");
    const saved = await fs.readFile(page.inpaintedImagePath);
    const failure = Object.assign(
      new Error("fixture staging directory is locked"),
      { code: "EACCES" },
    );
    spy.mockImplementation(async (path, options) => {
      if (String(path).includes("carrot-mcp-input-")) throw failure;
      return remove(path, options);
    });
    await expect(f.external.close()).rejects.toMatchObject({
      message: "External image session cleanup failed.",
      errors: [failure],
    });
    expect(await fs.readFile(page.inpaintedImagePath)).toEqual(saved);
    await expect(
      f.invoke("carrot_get_image_upload", { uploadId: image.uploadId }),
    ).rejects.toThrow();
  } finally {
    spy.mockImplementation((path, options) => remove(path, options));
    await f.close();
    vi.doUnmock("node:fs/promises");
  }
});
