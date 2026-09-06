import type {
  AutoMatchFontAssetDescriptor,
  InstalledAutoMatchFontAsset,
} from "./autoMatchActiveCatalogTypes";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { InstalledAutoMatchCandidate } from "./autoMatchActiveCatalogTypes";

async function verifyInstalledAssetBytes(
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

export async function installedCandidateAssetsMatch(
  expectedAssets: readonly AutoMatchFontAssetDescriptor[],
  installedAssets: readonly InstalledAutoMatchFontAsset[],
  reverifyInstalledAssetBytes: boolean,
): Promise<boolean> {
  for (
    let assetIndex = 0;
    assetIndex < expectedAssets.length;
    assetIndex += 1
  ) {
    const expectedAsset = expectedAssets[assetIndex];
    const installedAsset = installedAssets[assetIndex];
    if (
      !installedAsset ||
      installedAsset.file !== expectedAsset.file ||
      installedAsset.byteSize !== expectedAsset.byteSize ||
      installedAsset.sha256 !== expectedAsset.sha256
    ) {
      return false;
    }
    if (
      reverifyInstalledAssetBytes &&
      !(await verifyInstalledAssetBytes(installedAsset))
    ) {
      return false;
    }
  }
  return true;
}
