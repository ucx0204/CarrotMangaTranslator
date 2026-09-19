import { lstatSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CUDA_REDIST_BASE_URL,
  CUDA_REDIST_MANIFEST_URL,
  FLUX_ZLUDA_SUPPORT_DLLS,
  FLUX_ZLUDA_SUPPORT_RUNTIME_DIR,
} from "./constants";
import type { FluxAssetProgress } from "./types";
import {
  downloadRuntimeArchive,
  extractSelectedZipEntries,
  readJsonUrl,
  readNvidiaRedistPackage,
} from "./downloads";
import {
  createRuntimeStagingDirectory,
  replaceDirectoryWithRollback,
} from "../../runtimeSupport/runtimeDirectoryPublish";
import { runtimeMarkerPath } from "./cudaRuntime";

export async function ensureFluxZludaSupportRuntime(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const supportDir = join(options.runtimeDir, FLUX_ZLUDA_SUPPORT_RUNTIME_DIR);
  if (await isCurrentFluxZludaSupportRuntime(supportDir)) {
    options.onProgress?.({
      progressText: "Flux ZLUDA 보조 런타임 캐시 사용",
      detail: FLUX_ZLUDA_SUPPORT_RUNTIME_DIR,
      progressMode: "log-only",
      installLogLine: "캐시된 Flux ZLUDA cuRAND 보조 DLL을 사용합니다.",
    });
    return supportDir;
  }

  const stagingDir = createRuntimeStagingDirectory(supportDir);
  await mkdir(stagingDir, { recursive: true });
  try {
    const downloadsDir = join(options.runtimeDir, ".downloads");
    await mkdir(downloadsDir, { recursive: true });

    const cudaManifest = await readJsonUrl(
      CUDA_REDIST_MANIFEST_URL,
      options.signal,
    );
    const curandPackage = readNvidiaRedistPackage(
      cudaManifest,
      "libcurand",
      "windows-x86_64",
    );
    if (!curandPackage) {
      throw new Error(
        "NVIDIA CUDA 12.9 런타임 목록에서 cuRAND DLL 패키지를 찾지 못했습니다.",
      );
    }
    const archivePath = await downloadRuntimeArchive({
      ...options,
      downloadsDir,
      entry: curandPackage,
      baseUrl: CUDA_REDIST_BASE_URL,
      label: "Flux ZLUDA cuRAND 보조 런타임",
    });
    await extractSelectedZipEntries(
      archivePath,
      stagingDir,
      (fileName) => FLUX_ZLUDA_SUPPORT_DLLS.has(fileName),
      options.signal,
      false,
      supportDir,
    );
    if (!(await hasFluxZludaSupportRuntimeFiles(stagingDir))) {
      throw new Error(
        "Flux ZLUDA cuRAND 보조 런타임 설치가 완료되지 않았습니다.",
      );
    }
    await writeFile(
      runtimeMarkerPath(stagingDir),
      `${JSON.stringify(
        {
          cudaManifest: CUDA_REDIST_MANIFEST_URL,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await replaceDirectoryWithRollback(stagingDir, supportDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
  options.onProgress?.({
    progressText: "Flux ZLUDA 보조 런타임 설치 완료",
    detail: FLUX_ZLUDA_SUPPORT_RUNTIME_DIR,
    progressMode: "determinate",
    progressPercent: 1,
    installLogLine: "Flux ZLUDA cuRAND 보조 DLL 준비가 완료되었습니다.",
  });
  return supportDir;
}

async function isCurrentFluxZludaSupportRuntime(
  supportDir: string,
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(runtimeMarkerPath(supportDir), "utf8"),
    ) as { cudaManifest?: string };
    return (
      marker?.cudaManifest === CUDA_REDIST_MANIFEST_URL &&
      (await hasFluxZludaSupportRuntimeFiles(supportDir))
    );
  } catch (_error) {
    return false;
  }
}

async function hasFluxZludaSupportRuntimeFiles(
  supportDir: string,
): Promise<boolean> {
  return [...FLUX_ZLUDA_SUPPORT_DLLS].every((fileName) => {
    try {
      const info = lstatSync(join(supportDir, fileName));
      return info.isFile() && info.size > 0;
    } catch (_error) {
      return false;
    }
  });
}
