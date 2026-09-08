import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { nativeImage } from "electron";
import {
  rasterizeImageRedaction,
  flattenImageRedaction,
} from "../src/main/imageRedactionPixels";
import {
  readImageRedactionState,
  saveImageRedactionPages,
  setImageRedactionEnabled,
} from "../src/main/imageRedactionStore";
import {
  imageFingerprint,
  withApprovedImageRedactions,
  prepareExternalImageFile,
  registerImageRedactionCrop,
  externalImageMask,
  externalImageRegionIsHidden,
} from "../src/main/imageRedactionContext";
import type { ImageRedactionPage } from "../src/shared/imageRedaction";

// Electron's native pixel/file adapter only; all masking, persistence and approval code is real.
vi.mock("electron", async () => {
  const { readFileSync } = await import("node:fs");
  const { PNG } = await import("pngjs");
  const decode = (bytes: Buffer) => {
    const image = PNG.sync.read(bytes);
    return {
      isEmpty: () => false,
      getSize: () => ({ width: image.width, height: image.height }),
      toBitmap: () => image.data,
    };
  };
  return {
    nativeImage: {
      createFromPath: vi.fn((path: string) => decode(readFileSync(path))),
      createFromBuffer: vi.fn(decode),
      createFromBitmap: (
        data: Buffer,
        size: { width: number; height: number },
      ) => ({ toPNG: () => PNG.sync.write({ ...size, data } as PNG) }),
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "manga-redaction-test-"));
  roots.push(root);
  const path = join(root, "original.png");
  const png = new PNG({ width: 12, height: 12 });
  png.data.fill(37);
  await writeFile(path, PNG.sync.write(png));
  const page: ImageRedactionPage = {
    id: "page",
    name: "original.png",
    imagePath: path,
    width: 12,
    height: 12,
    fingerprint: await imageFingerprint(path),
    strokes: [
      {
        shape: "rectangle",
        size: 4,
        points: [
          { x: 4, y: 4 },
          { x: 8, y: 8 },
        ],
      },
    ],
  };
  return { root, page };
}
describe("manual image redaction", () => {
  it("keeps the original path when manual redaction is disabled", async () => {
    const { root, page } = await fixture();
    expect(await prepareExternalImageFile(page.imagePath, root)).toBe(
      page.imagePath,
    );
  });
  it.each(["width", "height"] as const)(
    "rejects an approved image whose %s no longer matches its mask coordinates",
    async (dimension) => {
      const { root, page } = await fixture();
      await withApprovedImageRedactions(
        [{ ...page, [dimension]: 24 }],
        async () => {
          await expect(
            prepareExternalImageFile(page.imagePath, root),
          ).rejects.toThrow("가리기 이미지 크기가 변경되었습니다.");
        },
      );
    },
  );
  it("redacts the approved bytes even when the source changes as decoding begins", async () => {
    const { root, page } = await fixture();
    const original = await readFile(page.imagePath);
    const replacement = new PNG({ width: 12, height: 12 });
    replacement.data.fill(180);
    const replacementBytes = PNG.sync.write(replacement);
    const decodePath = vi
      .mocked(nativeImage.createFromPath)
      .getMockImplementation();
    const decodeBuffer = vi
      .mocked(nativeImage.createFromBuffer)
      .getMockImplementation();
    if (!decodePath || !decodeBuffer)
      throw new Error("Missing native test decoder");
    vi.mocked(nativeImage.createFromPath).mockImplementationOnce((path) => {
      writeFileSync(page.imagePath, replacementBytes);
      return decodePath(path);
    });
    vi.mocked(nativeImage.createFromBuffer).mockImplementationOnce((bytes) => {
      writeFileSync(page.imagePath, replacementBytes);
      return decodeBuffer(bytes);
    });
    try {
      await withApprovedImageRedactions([page], async () => {
        const copy = await prepareExternalImageFile(page.imagePath, root);
        const output = PNG.sync.read(await readFile(copy));
        expect(output.data).toEqual(
          flattenImageRedaction(
            PNG.sync.read(original).data,
            rasterizeImageRedaction(page.width, page.height, page.strokes),
          ),
        );
        expect(await readFile(page.imagePath)).toEqual(replacementBytes);
      });
    } finally {
      vi.mocked(nativeImage.createFromPath)
        .mockReset()
        .mockImplementation(decodePath);
      vi.mocked(nativeImage.createFromBuffer)
        .mockReset()
        .mockImplementation(decodeBuffer);
    }
  });
  it("keeps the mask when Windows path decoding fails but the same file bytes are readable", async () => {
    const { root, page } = await fixture();
    const original = await readFile(page.imagePath);
    vi.mocked(nativeImage.createFromPath).mockReturnValueOnce({
      isEmpty: () => true,
    } as Electron.NativeImage);
    await withApprovedImageRedactions([page], async () => {
      const copy = await prepareExternalImageFile(page.imagePath, root);
      expect(nativeImage.createFromBuffer).toHaveBeenCalledWith(original);
      const result = PNG.sync.read(await readFile(copy));
      const mask = rasterizeImageRedaction(
        page.width,
        page.height,
        page.strokes,
      );
      expect(result.data).toEqual(
        flattenImageRedaction(PNG.sync.read(original).data, mask),
      );
      expect(await readFile(page.imagePath)).toEqual(original);
    });
  });
  it("stops redaction decoding when its approved job is cancelled", async () => {
    const { root, page } = await fixture();
    const controller = new AbortController();
    await withApprovedImageRedactions(
      [page],
      async () => {
        controller.abort();
        await expect(
          prepareExternalImageFile(page.imagePath, root),
        ).rejects.toThrow();
      },
      controller.signal,
    );
  });
  it("clears hidden RGB and alpha, preserving every other source byte", () => {
    const input = Buffer.alloc(10 * 10 * 4, 23);
    const mask = rasterizeImageRedaction(10, 10, [
      {
        shape: "rectangle",
        size: 2,
        points: [
          { x: 7, y: 7 },
          { x: 2, y: 2 },
        ],
      },
    ]);
    const output = flattenImageRedaction(input, mask);
    for (let pixel = 0; pixel < 100; pixel++)
      expect([...output.subarray(pixel * 4, pixel * 4 + 4)]).toEqual(
        Array(4).fill(mask[pixel] ? 255 : 23),
      );
    expect(input.every((value) => value === 23)).toBe(true);
    expect(() => flattenImageRedaction(Buffer.alloc(3), mask)).toThrow();
  });
  it.each(["round", "square"] as const)(
    "fills sparse %s strokes without gaps",
    (shape) => {
      const mask = rasterizeImageRedaction(30, 10, [
        {
          shape,
          size: 4,
          points: [
            { x: 2, y: 5 },
            { x: 28, y: 5 },
          ],
        },
      ]);
      for (let x = 2; x < 28; x++) expect(mask[5 * 30 + x]).toBe(255);
      expect(mask[0]).toBe(0);
    },
  );
  it("keeps enabled state and masks across concurrent narrow saves", async () => {
    const { root, page } = await fixture();
    expect((await readImageRedactionState(root)).enabled).toBe(false);
    await Promise.all([
      setImageRedactionEnabled(true, root),
      saveImageRedactionPages([page], root),
    ]);
    const saved = await readImageRedactionState(root);
    expect(saved).toEqual({
      enabled: true,
      pages: {
        [page.imagePath]: {
          fingerprint: page.fingerprint,
          strokes: page.strokes,
        },
      },
    });
    await writeFile(join(root, "image-redactions.json"), "broken");
    await expect(readImageRedactionState(root)).rejects.toThrow();
  });
  it("sends a flattened copy, rejects unreviewed paths and edits, and deletes only the temporary copy", async () => {
    const { root, page } = await fixture();
    await setImageRedactionEnabled(true, root);
    await expect(
      prepareExternalImageFile(page.imagePath, root),
    ).rejects.toThrow();
    const original = await readFile(page.imagePath);
    let copy = "";
    await withApprovedImageRedactions([page], async () => {
      copy = await prepareExternalImageFile(page.imagePath, root);
      expect(copy).not.toBe(page.imagePath);
      const decoded = PNG.sync.read(await readFile(copy));
      expect([
        ...decoded.data.subarray((5 * 12 + 5) * 4, (5 * 12 + 5) * 4 + 4),
      ]).toEqual([255, 255, 255, 255]);
      expect(decoded.data[0]).toBe(37);
      expect(await prepareExternalImageFile(page.imagePath, root)).toBe(copy);
      await expect(
        prepareExternalImageFile(join(root, "unreviewed.png"), root),
      ).rejects.toThrow();
      await writeFile(page.imagePath, Buffer.from("changed"));
      await expect(
        prepareExternalImageFile(page.imagePath, root),
      ).rejects.toThrow();
      await writeFile(page.imagePath, original);
    });
    await expect(readFile(copy)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(page.imagePath)).toEqual(original);
  });
  it("maps masks to resized crops and holds the whole intersecting SFX", async () => {
    const { root, page } = await fixture();
    const crop = join(root, "crop.png");
    await writeFile(crop, "crop");
    await withApprovedImageRedactions([page], async () => {
      expect(
        externalImageRegionIsHidden(page, { x: 300, y: 300, w: 400, h: 400 }),
      ).toBe(true);
      expect(
        externalImageRegionIsHidden(page, { x: 0, y: 0, w: 100, h: 100 }),
      ).toBe(false);
      await registerImageRedactionCrop(
        crop,
        page.imagePath,
        { x: 2, y: 2, w: 8, h: 8 },
        { width: 4, height: 4 },
      );
      const mask = externalImageMask(crop, 4, 4);
      expect(mask?.some(Boolean)).toBe(true);
      expect(() => externalImageMask(crop, 5, 4)).toThrow();
    });
  });
});
