import { mkdir, mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { assertPathWithinRootWithoutSymlinks } from "./libraryStore/libraryTransactionStorage";

export async function createFontChapterWorkspace(dataRoot: string) {
  const parent = join(dataRoot, "cache", "font-chapter-c18");
  await assertPathWithinRootWithoutSymlinks(dataRoot, parent, {
    allowMissingTarget: true,
  });
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "chapter-"));
  return { directory, remove: () => removeJobDirectory(dataRoot, directory) };
}

async function removeJobDirectory(dataRoot: string, directory: string) {
  const files: string[] = [];
  const directories: string[] = [];
  const inspect = async (path: string): Promise<void> => {
    await assertPathWithinRootWithoutSymlinks(dataRoot, path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      await assertPathWithinRootWithoutSymlinks(dataRoot, child);
      if (entry.isDirectory()) await inspect(child);
      else if (entry.isFile()) files.push(child);
      else
        throw new Error("C23 scratch directory contains an unsupported entry.");
    }
    directories.push(path);
  };
  // Validate the entire tree first; never follow links or recursively remove
  // a tree whose contents could point at originals, assets or library data.
  await inspect(directory);
  for (const path of files) {
    await assertPathWithinRootWithoutSymlinks(dataRoot, path);
    await unlink(path);
  }
  for (const path of directories) {
    await assertPathWithinRootWithoutSymlinks(dataRoot, path);
    await rmdir(path);
  }
}
