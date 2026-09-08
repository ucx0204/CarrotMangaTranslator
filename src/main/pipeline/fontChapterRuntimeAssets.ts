import type { AppPaths } from "../appPaths";
import type { RuntimeAssetProgress } from "../runtimeSupport/modelDownloads";
import approved from "./fontChapterC18Manifest.json";
import release from "./fontChapterReleaseManifest.json";
import { installFontChapterAssets } from "./fontChapterAssetInstaller";

export function resolveFontChapterRuntimeManifest(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
) {
  const key = `${platform}-${arch}`;
  if (key !== "win32-x64" && key !== "darwin-arm64")
    throw new Error(`Unsupported font matching platform: ${key}`);
  const entry = release.platforms[key];
  const manifest = {
    ...approved,
    assetDirectory: `${release.assetRoot}/${key}`,
    files: [
      ...approved.files.filter((row) => row.path !== "python-inventory.json"),
      ...release.licenseFiles,
      entry.pythonInventory,
    ],
  };
  const url = `https://github.com/ucx0204/CarrotMangaTranslator/releases/download/${release.tag}/${entry.archive.path}`;
  return { manifest, archive: entry.archive, url };
}

export async function prepareFontChapterRuntime(options: {
  paths: Pick<AppPaths, "dataRoot" | "runtimeDir">;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}) {
  const resolved = resolveFontChapterRuntimeManifest();
  const assets = await installFontChapterAssets({ ...options, ...resolved });
  return { assets, manifest: resolved.manifest };
}
