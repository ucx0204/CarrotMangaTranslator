import { join } from "node:path";
import { lstat } from "node:fs/promises";
import {
  capturePageRecovery,
  type PageRecoverySnapshot,
} from "../../shared/pageRecoverySnapshot";
import { hashStableValue } from "../../shared/blockFingerprint";
import { getLibraryRoot } from "../library";
import {
  assertPathWithinRootWithoutSymlinks,
  copyDurableBackup,
  sha256File,
} from "../libraryStore/libraryTransactionStorage";
import { McpEditError } from "../application/mcpEditPolicy";
import {
  RetainedPageStateSchema,
  MCP_RETAINED_FILE_BYTES,
  type RetainedFile,
  type RetainedPageState,
} from "./mcpRetentionRecords";

export async function inspectRetainedFile(path: string) {
  await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), path);
  const first = await lstat(path);
  if (
    !first.isFile() ||
    first.isSymbolicLink() ||
    first.size > MCP_RETAINED_FILE_BYTES
  )
    throw new McpEditError(
      "invalid_edit",
      "Retained image evidence requires a regular file at most 128 MiB.",
    );
  const sha256 = await sha256File(path);
  const last = await lstat(path);
  await assertPathWithinRootWithoutSymlinks(getLibraryRoot(), path);
  if (
    first.size !== last.size ||
    first.mtimeMs !== last.mtimeMs ||
    first.ino !== last.ino
  )
    throw new McpEditError(
      "revision_conflict",
      "Image evidence changed while reading.",
    );
  return { sha256, bytes: last.size };
}
export async function captureRetainedPage(
  page: PageRecoverySnapshot,
  directory?: string,
  copied = new Set<string>(),
): Promise<RetainedPageState> {
  const snapshot = capturePageRecovery(page);
  const paths = [
    ...new Set([page.imagePath, page.inpaintedImagePath, page.inpaintMaskPath]),
  ].filter((path): path is string => Boolean(path));
  const files: RetainedFile[] = [];
  for (const path of paths) {
    const evidence = await inspectRetainedFile(path);
    const asset = directory && path !== page.imagePath ? evidence.sha256 : null;
    if (asset && directory && !copied.has(asset)) {
      const hash = await copyDurableBackup(
        path,
        join(directory, `${asset}.bin`),
      );
      if (hash !== evidence.sha256)
        throw new McpEditError(
          "revision_conflict",
          "Image changed while retaining its recovery copy.",
        );
      copied.add(asset);
    }
    files.push({ path, ...evidence, asset });
  }
  return RetainedPageStateSchema.parse({
    page: snapshot,
    files,
    fingerprint: retainedPageFingerprint(snapshot, files),
  });
}
export function retainedPageFingerprint(
  page: PageRecoverySnapshot,
  files: RetainedFile[],
) {
  const value: Record<string, unknown> = {
    ...page,
    originalSha256: files.find((file) => file.path === page.imagePath)?.sha256,
  };
  for (const key of ["inpaintedImagePath", "inpaintMaskPath"] as const)
    if (page[key])
      value[key] = files.find((file) => file.path === page[key])?.sha256;
  return hashStableValue(value);
}
export async function verifyRetainedFiles(files: RetainedFile[]) {
  for (const file of files) {
    const actual = await inspectRetainedFile(file.path);
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes)
      throw new McpEditError(
        "revision_conflict",
        "Original or current image bytes changed; retained data was not applied or transferred.",
      );
  }
}
