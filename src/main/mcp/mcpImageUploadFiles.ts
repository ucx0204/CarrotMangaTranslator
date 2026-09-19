import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { McpEditError } from "../application/mcpEditPolicy";

export function imageUploadDigest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
export async function readImageUploadFile(file: string, size: number, sha256: string) {
  const handle = await openChecked(file, size);
  try {
    const bytes = await handle.readFile();
    if (bytes.length !== size || imageUploadDigest(bytes) !== sha256)
      throw new McpEditError("revision_conflict", "Received file content changed. Upload the correct bytes again.");
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function appendImageUploadFile(file: string, size: number, bytes: Buffer) {
  const handle = await openChecked(file, size, "r+");
  try {
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, size + written);
      if (!result.bytesWritten) throw new Error("Upload write made no progress.");
      written += result.bytesWritten;
    }
  } catch (error) {
    try {
      await handle.truncate(size);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Upload chunk write and rollback failed.");
    }
    throw error;
  } finally {
    await handle.close();
  }
}
async function openChecked(file: string, size: number, flags = "r") {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== size)
    throw new McpEditError("revision_conflict", "Upload file is missing, linked or changed.");
  const handle = await open(file, flags);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size !== size || actual.ino !== stats.ino || actual.dev !== stats.dev)
      throw new McpEditError("revision_conflict", "Upload file changed while opening.");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
