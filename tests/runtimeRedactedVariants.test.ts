import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
const { prepareImageVariants } =
  require("../src/main/runtime/assets/image-variants.cjs") as {
    prepareImageVariants: (
      options: Record<string, unknown>,
    ) => Promise<{ imageVariants: { path: string; dataUrl: string }[] }>;
  };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it.each([false, true])(
  "sanitizes every external reference before decoding, selected-region context=%s",
  async (extra) => {
    const root = await mkdtemp(join(tmpdir(), "redacted-variants-"));
    roots.push(root);
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(255);
    const safe = join(root, "safe.png");
    await writeFile(safe, PNG.sync.write(png));
    const prepare = vi.fn(async () => safe);
    const result = await prepareImageVariants({
      imagePath: "unreadable-original.png",
      imageWidth: 2,
      imageHeight: 2,
      prepareExternalImage: prepare,
      ...(extra
        ? {
            regionContextImagePath: "unreadable-context.png",
            regionCropMode: true,
            soundEffectTranslationMode: true,
          }
        : {}),
    });
    expect(prepare).toHaveBeenCalledTimes(extra ? 2 : 1);
    expect(
      result.imageVariants.every(
        (image) =>
          image.path === safe && image.dataUrl.startsWith("data:image/png"),
      ),
    ).toBe(true);
  },
);
