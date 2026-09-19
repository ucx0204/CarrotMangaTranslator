import { dirname, join, relative, resolve, sep } from "node:path";
import { readdir, rmdir } from "node:fs/promises";
import type { LibraryTransaction } from "./libraryTransaction";
import { isLibraryArtifactRetained } from "./libraryArtifactRetention";
import { assertPathWithinRootWithoutSymlinks } from "./libraryTransactionStorage";
import { unlinkIfExists } from "./storage";

type ImageReferences = {
  imagePath?: string;
  inpaintedImagePath?: string;
  inpaintMaskPath?: string;
};
const fields = ["imagePath", "inpaintedImagePath", "inpaintMaskPath"] as const;
const key = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

/** Recognize only the exact native recovery directory and field-owned filenames. */
export function isRecoveredImageArtifact(chapterDir: string, kind: "inpainted" | "mask", path: string) {
  const parts = relative(resolve(chapterDir), resolve(path)).split(sep);
  return parts.length === 2 &&
    /^\.mcp-recovered-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parts[0]) &&
    parts[1] === (kind === "mask" ? "inpaintMaskPath.png" : "inpaintedImagePath.png");
}
const isRecovered = (root: string, path: string) =>
  isRecoveredImageArtifact(root, "inpainted", path) || isRecoveredImageArtifact(root, "mask", path);

/** Candidate-only cleanup: current references and active artifact leases were checked by the caller. */
export async function removeManagedImageCandidate(chapterDir: string, path: string) {
  if (!isRecovered(chapterDir, path)) {
    await unlinkIfExists(resolve(path));
    return;
  }
  await assertPathWithinRootWithoutSymlinks(chapterDir, path);
  await unlinkIfExists(resolve(path));
  try { await rmdir(dirname(path)); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** A recovered working image is disposable only after its replacement is in the same
 * native transaction. Never enumerate the chapter or retire a current/original/leased file. */
export async function retireReplacedRecoveryImages(
  transaction: LibraryTransaction,
  chapterDir: string,
  before: readonly ImageReferences[],
  after: readonly ImageReferences[],
) {
  const live = new Set(after.flatMap(page => fields.flatMap(field => page[field] ? [key(page[field])] : [])));
  const groups = new Map<string, Set<string>>();
  for (const page of before) for (const field of ["inpaintedImagePath", "inpaintMaskPath"] as const) {
    const path = page[field];
    if (!path || !isRecovered(chapterDir, path) || live.has(key(path)) || isLibraryArtifactRetained(path)) continue;
    const directory = dirname(path);
    const files = groups.get(directory) ?? new Set<string>();
    files.add(path);
    groups.set(directory, files);
  }
  for (const [directory, files] of groups) {
    await assertPathWithinRootWithoutSymlinks(chapterDir, directory);
    const contents = await readdir(directory, { withFileTypes: true });
    const candidates = new Set([...files].map(key));
    const ownsAll = contents.length > 0 && contents.every(item => item.isFile() && candidates.has(key(join(directory, item.name))));
    if (ownsAll) await transaction.retireDirectory(directory, { required: true });
    else for (const path of files) await transaction.retireFile(path, { required: true });
  }
}
