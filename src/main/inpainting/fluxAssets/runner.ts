import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  FLUX_NVIDIA_RUNNER_ASSETS,
  FLUX_NVIDIA_RUNNER_BASE_URL,
  FLUX_NVIDIA_RUNNER_COMPUTE_CAPS,
  FLUX_NVIDIA_RUNNER_MARKER,
  FLUX_RUNNER_DIR,
  FLUX_RUNTIME_EXECUTABLE,
} from "./constants";
import { extractZipSafely } from "./downloads";
import { downloadToFile } from "../../runtimeSupport/modelDownloads";
import { throwIfAborted } from "./errors";
import {
  isExecutableFile,
  sha256FileSync,
} from "../../runtimeSupport/fileProbe";
import type { FluxAssetProgress } from "./types";

type LocalFluxRunnerSource = {
  kind: "local";
  dirName: string;
  label: string;
  path: string;
};

type RemoteFluxRunnerSource = {
  kind: "remote";
  dirName: string;
  fileName: string;
  label: string;
  sha256: string;
  url: string;
};

type FluxRunnerSource = LocalFluxRunnerSource | RemoteFluxRunnerSource;

export async function ensureManagedFluxRunner(options: {
  runtimeDir: string;
  nvidiaComputeCapability?: number | null;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const source = resolveFluxRunnerSource(options.nvidiaComputeCapability);
  if (!source) {
    throw new Error(
      buildMissingFluxRunnerMessage(options.nvidiaComputeCapability),
    );
  }

  const managedDir = join(options.runtimeDir, source.dirName);
  const managedPath = join(managedDir, FLUX_RUNTIME_EXECUTABLE);

  throwIfAborted(options.signal);
  if (source.kind === "remote") {
    return ensureDownloadedFluxRunner({
      ...options,
      managedDir,
      managedPath,
      source,
    });
  }

  await mkdir(managedDir, { recursive: true });
  if (
    isExecutableFile(managedPath) &&
    sha256FileSync(managedPath) === sha256FileSync(source.path)
  ) {
    return managedPath;
  }
  await copyFile(source.path, managedPath);
  if (process.platform !== "win32") {
    await chmod(managedPath, 0o755);
  }
  options.onProgress?.({
    progressText: "Flux 실행 파일 준비 중",
    detail: source.label,
    progressMode: "log-only",
    installLogLine: `Flux 실행 파일을 앱 데이터 캐시에 갱신했습니다: ${source.label}`,
  });
  return managedPath;
}

export function resolveFluxRunnerDirForComputeCapability(
  computeCapability?: number | null,
): string | null {
  const normalized = normalizeCudaComputeCapability(computeCapability);
  if (!normalized || !FLUX_NVIDIA_RUNNER_COMPUTE_CAPS.includes(normalized)) {
    return null;
  }
  return formatFluxRunnerDirForComputeCap(normalized);
}

function resolveFluxRunnerSource(
  nvidiaComputeCapability?: number | null,
): FluxRunnerSource | null {
  const explicit = process.env.MGT_FLUX_KLEIN_EXE;
  if (explicit && isExecutableFile(explicit)) {
    return {
      kind: "local",
      dirName: FLUX_RUNNER_DIR,
      label: basename(explicit),
      path: explicit,
    };
  }

  const normalized = normalizeCudaComputeCapability(nvidiaComputeCapability);
  if (normalized) {
    const dirName = resolveFluxRunnerDirForComputeCapability(
      nvidiaComputeCapability,
    );
    if (!dirName) {
      return null;
    }
    const localSource = findLocalFluxRunnerSource(dirName);
    if (localSource) {
      return localSource;
    }
    return resolveRemoteFluxRunnerSource(normalized, dirName);
  }

  return findLocalFluxRunnerSource(FLUX_RUNNER_DIR);
}

function findLocalFluxRunnerSource(
  dirName: string,
): LocalFluxRunnerSource | null {
  for (const toolsRoot of resolveFluxRunnerToolsRoots()) {
    const path = [
      join(toolsRoot, dirName, FLUX_RUNTIME_EXECUTABLE),
      ...(dirName === FLUX_RUNNER_DIR
        ? [
            join(
              toolsRoot,
              "mgt-flux-klein-runner",
              "target",
              "aarch64-apple-darwin",
              "release",
              FLUX_RUNTIME_EXECUTABLE,
            ),
            join(
              toolsRoot,
              "mgt-flux-klein-runner",
              "target",
              "release",
              FLUX_RUNTIME_EXECUTABLE,
            ),
          ]
        : []),
    ].find(isExecutableFile);
    if (path) {
      return {
        kind: "local",
        dirName,
        label:
          dirName === FLUX_RUNNER_DIR
            ? FLUX_RUNTIME_EXECUTABLE
            : `${dirName}/${FLUX_RUNTIME_EXECUTABLE}`,
        path,
      };
    }
  }
  return null;
}

function resolveFluxRunnerToolsRoots(): string[] {
  if (process.env.MGT_FLUX_KLEIN_TOOLS_DIR) {
    return uniqueStrings([process.env.MGT_FLUX_KLEIN_TOOLS_DIR]);
  }
  return uniqueStrings([
    process.resourcesPath ? join(process.resourcesPath, "tools") : undefined,
    join(process.cwd(), "tools"),
  ]);
}

function resolveRemoteFluxRunnerSource(
  normalizedComputeCapability: string,
  dirName: string,
): RemoteFluxRunnerSource | null {
  if (isTruthyEnv(process.env.MGT_FLUX_DISABLE_REMOTE_RUNNER_DOWNLOAD)) {
    return null;
  }
  const assets = FLUX_NVIDIA_RUNNER_ASSETS as Record<
    string,
    { fileName: string; sha256: string }
  >;
  const asset = assets[normalizedComputeCapability];
  if (!asset) {
    return null;
  }
  const configuredBaseUrl = process.env.MGT_FLUX_KLEIN_RUNNER_BASE_URL;
  const baseUrl = (
    configuredBaseUrl === undefined
      ? FLUX_NVIDIA_RUNNER_BASE_URL
      : configuredBaseUrl
  )
    .trim()
    .replace(/\/+$/, "");
  if (!baseUrl) {
    return null;
  }
  return {
    kind: "remote",
    dirName,
    fileName: asset.fileName,
    label: `${dirName}/${FLUX_RUNTIME_EXECUTABLE}`,
    sha256: resolveRunnerAssetSha256(normalizedComputeCapability, asset.sha256),
    url: `${baseUrl}/${asset.fileName}`,
  };
}

async function ensureDownloadedFluxRunner(options: {
  runtimeDir: string;
  managedDir: string;
  managedPath: string;
  source: RemoteFluxRunnerSource;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  if (
    await isCurrentDownloadedFluxRunner(options.managedPath, options.source)
  ) {
    options.onProgress?.({
      progressText: "Flux 실행 파일 캐시 사용",
      detail: options.source.label,
      progressMode: "log-only",
      installLogLine: `캐시된 GPU별 Flux 실행 파일을 사용합니다: ${options.source.label}`,
    });
    return options.managedPath;
  }

  const downloadsDir = join(options.runtimeDir, ".downloads", "flux-runners");
  const archivePath = join(downloadsDir, options.source.fileName);
  await downloadToFile({
    url: options.source.url,
    outputPath: archivePath,
    signal: options.signal,
    progressText: "Flux 실행 파일 다운로드 중",
    label: options.source.fileName,
    onProgress: options.onProgress,
  });
  await verifyFluxRunnerArchiveHash(archivePath, options.source);
  await rm(options.managedDir, { recursive: true, force: true });
  await mkdir(options.managedDir, { recursive: true });
  extractZipSafely(archivePath, options.managedDir);
  if (!isExecutableFile(options.managedPath)) {
    throw new Error(
      `${options.source.fileName}에서 ${FLUX_RUNTIME_EXECUTABLE}를 찾지 못했습니다.`,
    );
  }

  await writeDownloadedRunnerMarker(options);
  options.onProgress?.({
    progressText: "Flux 실행 파일 준비 중",
    detail: options.source.label,
    progressMode: "log-only",
    installLogLine: `GPU별 Flux 실행 파일을 앱 데이터 캐시에 설치했습니다: ${options.source.label}`,
  });
  return options.managedPath;
}

async function writeDownloadedRunnerMarker(options: {
  managedDir: string;
  managedPath: string;
  source: RemoteFluxRunnerSource;
}): Promise<void> {
  await writeFile(
    downloadedRunnerMarkerPath(options.managedDir),
    `${JSON.stringify(
      {
        archiveSha256: options.source.sha256,
        executableSha256: sha256FileSync(options.managedPath),
        fileName: options.source.fileName,
        installedAt: new Date().toISOString(),
        url: options.source.url,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function isCurrentDownloadedFluxRunner(
  managedPath: string,
  source: RemoteFluxRunnerSource,
): Promise<boolean> {
  if (!isExecutableFile(managedPath)) {
    return false;
  }
  try {
    const marker = JSON.parse(
      await readFile(downloadedRunnerMarkerPath(dirname(managedPath)), "utf8"),
    ) as {
      archiveSha256?: string;
      executableSha256?: string;
      fileName?: string;
      url?: string;
    };
    return (
      marker.archiveSha256 === source.sha256 &&
      marker.fileName === source.fileName &&
      marker.url === source.url &&
      typeof marker.executableSha256 === "string" &&
      marker.executableSha256 === sha256FileSync(managedPath)
    );
  } catch (_error) {
    return false;
  }
}

async function verifyFluxRunnerArchiveHash(
  archivePath: string,
  source: RemoteFluxRunnerSource,
): Promise<void> {
  const actual = sha256FileSync(archivePath).toLowerCase();
  if (actual === source.sha256) {
    return;
  }
  await rm(archivePath, { force: true });
  throw new Error(
    `${source.fileName} SHA-256 검증에 실패했습니다. expected=${source.sha256}, actual=${actual}`,
  );
}

function downloadedRunnerMarkerPath(managedDir: string): string {
  return join(managedDir, FLUX_NVIDIA_RUNNER_MARKER);
}

function buildMissingFluxRunnerMessage(
  nvidiaComputeCapability?: number | null,
): string {
  const normalized = normalizeCudaComputeCapability(nvidiaComputeCapability);
  if (normalized) {
    const requiredDir = formatFluxRunnerDirForComputeCap(normalized);
    const supported = FLUX_NVIDIA_RUNNER_COMPUTE_CAPS.map(
      (cap) => `sm${cap}`,
    ).join(", ");
    if (!FLUX_NVIDIA_RUNNER_COMPUTE_CAPS.includes(normalized)) {
      return (
        `Flux NVIDIA 실행 파일이 이 GPU compute capability ${formatCudaComputeCapability(normalized)}(sm${normalized})를 지원하지 않습니다. ` +
        `지원되는 대상은 ${supported}입니다. 정확한 sm 타깃 러너가 필요하며 낮은 sm/generic 러너로 대체하지 않습니다.`
      );
    }
    return (
      `${requiredDir}/${FLUX_RUNTIME_EXECUTABLE}를 준비하지 못했습니다. ` +
      `감지된 NVIDIA GPU compute capability ${formatCudaComputeCapability(normalized)}에는 정확히 sm${normalized} 러너가 필요합니다. ` +
      `설치 파일 또는 Flux runner 다운로드 자산을 확인하세요.`
    );
  }
  return (
    `${FLUX_RUNTIME_EXECUTABLE}를 찾지 못했습니다. 설치 파일에 Flux Klein 실행 파일이 포함되어 있어야 합니다. ` +
    `개발 환경에서는 node scripts/prepare-flux-klein-runner.cjs를 실행하거나 MGT_FLUX_KLEIN_EXE로 경로를 지정하세요.`
  );
}

function formatFluxRunnerDirForComputeCap(computeCap: string): string {
  return `${FLUX_RUNNER_DIR}-sm${computeCap}`;
}

function normalizeCudaComputeCapability(value?: number | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const major = Math.floor(value);
  const minor = Math.round((value - major) * 10);
  if (major <= 0 || minor < 0 || minor > 9) {
    return null;
  }
  return `${major}${minor}`;
}

function formatCudaComputeCapability(normalized: string): string {
  if (normalized.length <= 1) {
    return normalized;
  }
  return `${normalized.slice(0, -1)}.${normalized.slice(-1)}`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isTruthyEnv(value?: string): boolean {
  return ["1", "true", "yes", "on"].includes(
    (value || "").trim().toLowerCase(),
  );
}

function resolveRunnerAssetSha256(
  normalizedComputeCapability: string,
  defaultSha256: string,
): string {
  const override = process.env[
    `MGT_FLUX_KLEIN_RUNNER_SHA256_SM${normalizedComputeCapability}`
  ]
    ?.trim()
    .toLowerCase();
  return override && /^[a-f0-9]{64}$/.test(override)
    ? override
    : defaultSha256.toLowerCase();
}
