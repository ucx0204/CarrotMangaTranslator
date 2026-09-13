import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Source identity is a filesystem adapter; it needs no image decoder or Electron. */
export async function fingerprintImageFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
