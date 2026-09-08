import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppPaths } from "../appPaths";
import {
  assertRuntimeFunctions,
  loadRuntimeModuleFromDirectory,
} from "../runtimeModuleLoader";
import { AbortableExclusiveGate } from "../runtimeSupport/abortableExclusiveGate";
import {
  ensureRemoteFile,
  type RuntimeAssetProgress,
} from "../runtimeSupport/modelDownloads";
import {
  verifyFontChapterAssets,
  type FontChapterAssetFile,
  type FontChapterAssetManifest,
} from "./fontChapterAssetVerification";

const installationGate = new AbortableExclusiveGate();
type ZipRuntime = {
  extractSelectedZipEntries: (
    archive: string,
    output: string,
    select: () => boolean,
    options: {
      abortSignal?: AbortSignal;
      preserveRelativePaths: boolean;
      replaceOutputDir: boolean;
      finalOutputDir: string;
    },
  ) => Promise<void>;
};
type PublicationRuntime = {
  replaceDirectoryWithRollback: (
    source: string,
    destination: string,
  ) => Promise<void>;
};

export async function installFontChapterAssets(options: {
  paths: Pick<AppPaths, "dataRoot" | "runtimeDir">;
  manifest: FontChapterAssetManifest;
  archive: FontChapterAssetFile;
  url: string;
  signal?: AbortSignal;
  onProgress?: (progress: RuntimeAssetProgress) => void;
}): Promise<string> {
  const lease = await installationGate.acquire(options.signal);
  try {
    return await installExclusive(options);
  } finally {
    lease.release();
  }
}

async function installExclusive(
  options: Parameters<typeof installFontChapterAssets>[0],
): Promise<string> {
  const { paths, manifest, signal } = options;
  const target = join(paths.dataRoot, manifest.assetDirectory);
  try {
    await verifyFontChapterAssets(target, manifest, signal);
    return target;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const archive = await ensureRemoteFile({
    modelDir: join(paths.dataRoot, "cache", "font-chapter-assets"),
    url: options.url,
    fileName: options.archive.path,
    label: "Font matching C23",
    expectedSha256: options.archive.sha256,
    minimumBytes: options.archive.bytes,
    maximumBytes: options.archive.bytes,
    expectedTotalBytes: options.archive.bytes,
    progressPhase: "font_matching_downloading",
    signal,
    onProgress: options.onProgress,
  });
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), ".s-"));
  try {
    const zip = loadRuntimeModuleFromDirectory(
      paths.runtimeDir,
      "zipExtractor",
    );
    assertRuntimeFunctions(zip, "zipExtractor", ["extractSelectedZipEntries"]);
    await (zip as ZipRuntime).extractSelectedZipEntries(
      archive,
      staging,
      () => true,
      {
        abortSignal: signal,
        preserveRelativePaths: true,
        replaceOutputDir: true,
        finalOutputDir: target,
      },
    );
    await verifyFontChapterAssets(staging, manifest, signal);
    signal?.throwIfAborted();
    const publisher = loadRuntimeModuleFromDirectory(
      paths.runtimeDir,
      "directoryPublisher",
    );
    assertRuntimeFunctions(publisher, "directoryPublisher", [
      "replaceDirectoryWithRollback",
    ]);
    await (publisher as PublicationRuntime).replaceDirectoryWithRollback(
      staging,
      target,
    );
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
