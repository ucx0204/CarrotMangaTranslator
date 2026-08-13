import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { InstalledAutoMatchCandidate } from "./autoMatchActiveCatalogTypes";

export async function verifyInstalledAssetBytes(
  asset: InstalledAutoMatchCandidate["assets"][number],
): Promise<boolean> {
  try {
    const [stat, bytes] = await Promise.all([
      lstat(asset.resolvedFile),
      readFile(asset.resolvedFile),
    ]);
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size === asset.byteSize &&
      bytes.byteLength === asset.byteSize &&
      createHash("sha256").update(bytes).digest("hex") === asset.sha256
    );
  } catch (_error) {
    return false;
  }
}
