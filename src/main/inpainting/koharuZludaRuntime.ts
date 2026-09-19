import { lstatSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { downloadToFile } from "../runtimeSupport/modelDownloads";
import { sha256FileSync } from "../runtimeSupport/fileProbe";
import { MAX_REMOTE_RUNTIME_ARCHIVE_BYTES } from "../runtimeSupport/downloadBudgets";
import {
  createRuntimeStagingDirectory,
  replaceDirectoryWithRollback,
} from "../runtimeSupport/runtimeDirectoryPublish";
import { extractSelectedZipEntries } from "./fluxAssets/downloads";
import { throwIfAborted } from "./fluxAssets/errors";
import type { InpaintingRuntimeProgress } from "./inpaintingEngine";
import {
  KOHARU_ZLUDA_SOURCE,
  type KoharuZludaSource,
} from "./koharuZludaManifest";

/** Validate/repair before spawning even the existing native runner, whose
 * bootstrap only checks DLL existence. The native runner still owns HIP
 * activation and CUDA aliases. No NVIDIA cuFFT DLL is installed here. */
export async function ensureKoharuZludaRuntime(
  options: {
    runtimeRoot: string;
    signal?: AbortSignal;
    onProgress?: (progress: InpaintingRuntimeProgress) => void;
  },
  source: KoharuZludaSource = KOHARU_ZLUDA_SOURCE,
): Promise<void> {
  throwIfAborted(options.signal);
  const runtimeDir = join(options.runtimeRoot, "runtime");
  const outputDir = join(runtimeDir, "zluda");
  if (hasVerifiedZludaFiles(outputDir, source)) return;
  const stagingDir = createRuntimeStagingDirectory(outputDir);
  try {
    const downloadsDir = join(runtimeDir, ".downloads");
    await mkdir(downloadsDir, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    const archivePath = join(downloadsDir, source.fileName);
    await downloadToFile({
      url: source.url,
      outputPath: archivePath,
      expectedSha256: source.sha256,
      expectedTotalBytes: source.bytes,
      maximumBytes: MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
      label: "Koharu ZLUDA runtime",
      progressText: "Koharu ZLUDA runtime",
      signal: options.signal,
      onProgress: options.onProgress,
    });
    await extractSelectedZipEntries(
      archivePath,
      stagingDir,
      (fileName, relativePath) =>
        Object.hasOwn(source.dlls, fileName) &&
        relativePath === `zluda/${fileName}`,
      options.signal,
      false,
      outputDir,
    );
    if (!hasVerifiedZludaFiles(stagingDir, source)) {
      throw new Error("Koharu ZLUDA runtime DLL integrity validation failed.");
    }
    throwIfAborted(options.signal);
    await replaceDirectoryWithRollback(stagingDir, outputDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function hasVerifiedZludaFiles(
  directory: string,
  source: KoharuZludaSource,
): boolean {
  return Object.entries(source.dlls).every(([name, expected]) => {
    try {
      const path = join(directory, name);
      const info = lstatSync(path);
      return (
        info.isFile() &&
        info.size === expected.bytes &&
        sha256FileSync(path) === expected.sha256
      );
    } catch (_error) {
      return false;
    }
  });
}
