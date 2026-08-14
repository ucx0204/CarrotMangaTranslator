import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import * as yazl from "yazl";

import {
  FLUX_CUDA_DLLS,
  FLUX_CUDA_RUNTIME_DIR,
  FLUX_CUDNN_DLLS,
} from "../src/main/inpainting/fluxAssets/constants";
import { extractFluxCudaRuntimeArchiveToStaging } from "../src/main/inpainting/fluxAssets/cudaRuntime";
import {
  createRuntimeStagingDirectory,
  replaceDirectoryWithRollback,
} from "../src/main/runtimeSupport/runtimeDirectoryPublish";

const tempDirs: string[] = [];
const COMPACT_BACKUP_BASENAME = ".b-0000000000000000";
const describeWindows = process.platform === "win32" ? describe : describe.skip;

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("Flux CUDA runtime path publication", () => {
  it("extracts real ZIP entries after validating every path at the 251-character boundary", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "mgt-flux-cuda-path-"));
    tempDirs.push(testRoot);
    const selectedNames = [...FLUX_CUDA_DLLS, ...FLUX_CUDNN_DLLS];
    const longestFileName = findLongestFileName(selectedNames);
    const runtimeRoot = resolveBoundaryRuntimeRoot(
      testRoot,
      longestFileName,
      251,
    );
    const finalCudaDir = join(runtimeRoot, FLUX_CUDA_RUNTIME_DIR);
    const stagingDir = createRuntimeStagingDirectory(
      join(testRoot, "cuda-staging-anchor"),
    );
    const cudaArchivePath = join(testRoot, "cuda.zip");
    const cudnnArchivePath = join(testRoot, "cudnn.zip");
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    await writeZip(cudaArchivePath, [...FLUX_CUDA_DLLS]);
    await writeZip(cudnnArchivePath, [...FLUX_CUDNN_DLLS]);

    await extractFluxCudaRuntimeArchiveToStaging({
      archivePath: cudaArchivePath,
      runtimeDir: runtimeRoot,
      selectedFileNames: FLUX_CUDA_DLLS,
      stagingDir,
    });
    await extractFluxCudaRuntimeArchiveToStaging({
      archivePath: cudnnArchivePath,
      runtimeDir: runtimeRoot,
      selectedFileNames: FLUX_CUDNN_DLLS,
      stagingDir,
    });

    expect(basename(stagingDir)).toMatch(/^\.s-[a-f0-9]{16}$/);
    expect(stagingDir).not.toBe(finalCudaDir);
    for (const fileName of selectedNames) {
      await expect(stat(join(stagingDir, fileName))).resolves.toMatchObject({
        size: 7,
      });
    }
    await replaceDirectoryWithRollback(stagingDir, finalCudaDir);
    for (const fileName of selectedNames) {
      await expect(stat(join(finalCudaDir, fileName))).resolves.toMatchObject({
        size: 7,
      });
    }
    const longestCheckedPath = resolve(
      runtimeRoot,
      COMPACT_BACKUP_BASENAME,
      longestFileName,
    );
    expect(longestCheckedPath.length).toBeLessThan(252);
    if (process.platform === "win32")
      expect(longestCheckedPath).toHaveLength(251);
  });
});

describeWindows("Flux CUDA Windows path rejection", () => {
  it("rejects a real ZIP before extraction when the final rollback path reaches 252 characters", async () => {
    const testRoot = await mkdtemp(join(tmpdir(), "mgt-flux-cuda-limit-"));
    tempDirs.push(testRoot);
    const longestFileName = findLongestFileName([
      ...FLUX_CUDA_DLLS,
      ...FLUX_CUDNN_DLLS,
    ]);
    const runtimeRoot = resolveBoundaryRuntimeRoot(
      testRoot,
      longestFileName,
      252,
    );
    const stagingDir = createRuntimeStagingDirectory(
      join(testRoot, "cuda-staging-anchor"),
    );
    const archivePath = join(testRoot, "boundary.zip");
    await mkdir(stagingDir, { recursive: true });
    await writeZip(archivePath, [longestFileName]);

    await expect(
      extractFluxCudaRuntimeArchiveToStaging({
        archivePath,
        runtimeDir: runtimeRoot,
        selectedFileNames: new Set([longestFileName]),
        stagingDir,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("runtime ZIP final backup path"),
      nonRetriable: true,
      runtimePathLength: 252,
      windowsPathCeiling: 252,
      windowsPathUnsafe: true,
    });
    await expect(stat(join(stagingDir, longestFileName))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});

function findLongestFileName(fileNames: string[]): string {
  return fileNames.reduce((longest, fileName) =>
    fileName.length > longest.length ? fileName : longest,
  );
}

function resolveBoundaryRuntimeRoot(
  testRoot: string,
  longestFileName: string,
  targetLength: number,
): string {
  if (process.platform !== "win32") return testRoot;
  const baseBoundaryPath = resolve(
    testRoot,
    "r-",
    COMPACT_BACKUP_BASENAME,
    longestFileName,
  );
  const paddingLength = targetLength - baseBoundaryPath.length;
  if (paddingLength < 0) {
    throw new Error("Temporary test root is too long for the path fixture.");
  }
  return join(testRoot, `r-${"x".repeat(paddingLength)}`);
}

async function writeZip(
  archivePath: string,
  fileNames: string[],
): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const fileName of fileNames) {
    zip.addBuffer(Buffer.from("runtime"), `payload/${fileName}`);
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(archivePath));
}
