import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

const fileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FontChapterAssetFile = z.infer<typeof fileSchema>;
export type FontChapterAssetManifest = {
  files: FontChapterAssetFile[];
  assetDirectory: string;
};

export async function verifyFontChapterAssetFile(
  root: string,
  row: FontChapterAssetFile,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  if (isAbsolute(row.path) || row.path.includes("\\"))
    throw new Error("Unsafe font asset path");
  const file = resolve(root, row.path);
  if (relative(root, file).split(/[\\/]/).includes(".."))
    throw new Error("Font asset escapes its installation");
  const info = await lstat(file);
  if (!info.isFile() || info.size !== row.bytes)
    throw new Error(`Font asset size or type mismatch: ${row.path}`);
  const actual = relative(await realpath(root), await realpath(file));
  if (actual.replaceAll("\\", "/") !== row.path)
    throw new Error(`Linked font asset: ${row.path}`);
  const data = await readFile(file, { signal });
  if (createHash("sha256").update(data).digest("hex") !== row.sha256)
    throw new Error(`Font asset digest mismatch: ${row.path}`);
  return data;
}

export async function verifyFontChapterAssets(
  root: string,
  manifest: FontChapterAssetManifest,
  signal?: AbortSignal,
): Promise<void> {
  const inventory = manifest.files.find(
    (row) => row.path === "python-inventory.json",
  );
  if (!inventory) throw new Error("Font dependency inventory is missing");
  const data = await verifyFontChapterAssetFile(root, inventory, signal);
  const dependencies = z
    .object({ files: z.array(fileSchema) })
    .parse(JSON.parse(data.toString("utf8")));
  const files = [...manifest.files, ...dependencies.files];
  if (new Set(files.map((row) => row.path)).size !== files.length)
    throw new Error("Duplicate font asset path");
  for (let index = 0; index < files.length; index += 16) {
    await Promise.all(
      files
        .slice(index, index + 16)
        .map((row) => verifyFontChapterAssetFile(root, row, signal)),
    );
  }
}
