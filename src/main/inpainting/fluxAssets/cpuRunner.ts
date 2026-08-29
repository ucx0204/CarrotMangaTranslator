import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  FLUX_CPU_RUNNER_ARCHIVE_BYTES,
  FLUX_CPU_RUNNER_ARCHIVE_SHA256,
  FLUX_CPU_RUNNER_ASSET_FILE,
  FLUX_CPU_RUNNER_BASE_URL,
  FLUX_CPU_RUNNER_DIR,
  FLUX_CPU_RUNNER_EXECUTABLE_BYTES,
  FLUX_CPU_RUNNER_EXECUTABLE_SHA256,
  FLUX_CPU_RUNNER_MARKER,
  FLUX_CPU_RUNTIME_EXECUTABLE,
} from "./constants";
import { extractZipSafely } from "./downloads";
import { throwIfAborted } from "./errors";
import { downloadToFile } from "../../runtimeSupport/modelDownloads";
import { MAX_REMOTE_RUNTIME_ARCHIVE_BYTES } from "../../runtimeSupport/downloadBudgets";
import {
  isExecutableFile,
  sha256FileSync,
} from "../../runtimeSupport/fileProbe";
import type { FluxAssetProgress } from "./types";
import { isTruthyEnv } from "./runnerSourceHelpers";

type LocalFluxCpuRunnerSource = {
  kind: "local";
  label: string;
  path: string;
};

type RemoteFluxCpuRunnerSource = {
  kind: "remote";
  archiveBytes: number;
  archiveSha256: string;
  executableBytes: number;
  executableSha256: string;
  fileName: string;
  label: string;
  url: string;
};

type FluxCpuRunnerSource = LocalFluxCpuRunnerSource | RemoteFluxCpuRunnerSource;

export async function ensureManagedFluxCpuRunner(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const source = resolveFluxCpuRunnerSource();
  if (!source) {
    throw new Error(
      `${FLUX_CPU_RUNNER_DIR}/${FLUX_CPU_RUNTIME_EXECUTABLE}를 준비하지 못했습니다. ` +
        "네트워크 연결과 Flux CPU runner 다운로드 자산을 확인하세요. 개발 환경에서는 npm run build:flux-cpu-runner를 실행하거나 MGT_FLUX_KLEIN_CPU_EXE로 경로를 지정할 수 있습니다.",
    );
  }
  const managedDir = join(options.runtimeDir, FLUX_CPU_RUNNER_DIR);
  const managedPath = join(managedDir, FLUX_CPU_RUNTIME_EXECUTABLE);
  throwIfAborted(options.signal);
  if (source.kind === "remote") {
    return ensureDownloadedFluxCpuRunner({
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
  throwIfAborted(options.signal);
  await copyFile(source.path, managedPath);
  if (process.platform !== "win32") {
    await chmod(managedPath, 0o755);
  }
  await rm(downloadedRunnerMarkerPath(managedDir), { force: true });
  options.onProgress?.({
    progressText: "Flux 실행 파일 준비 중",
    detail: source.label,
    progressMode: "log-only",
    installLogLine: `Flux 실행 파일을 앱 데이터 캐시에 갱신했습니다: ${source.label}`,
  });
  return managedPath;
}

function resolveFluxCpuRunnerSource(): FluxCpuRunnerSource | null {
  const local = resolveLocalFluxCpuRunnerSource();
  if (local) {
    return local;
  }
  if (isTruthyEnv(process.env.MGT_FLUX_DISABLE_REMOTE_CPU_RUNNER_DOWNLOAD)) {
    return null;
  }
  const configuredBaseUrl = process.env.MGT_FLUX_KLEIN_CPU_RUNNER_BASE_URL;
  const baseUrl = (
    configuredBaseUrl === undefined
      ? FLUX_CPU_RUNNER_BASE_URL
      : configuredBaseUrl
  )
    .trim()
    .replace(/\/+$/u, "");
  if (!baseUrl) {
    return null;
  }
  return {
    kind: "remote",
    archiveBytes: resolvePositiveIntegerEnv(
      "MGT_FLUX_KLEIN_CPU_RUNNER_BYTES",
      FLUX_CPU_RUNNER_ARCHIVE_BYTES,
    ),
    archiveSha256: resolveSha256Env(
      "MGT_FLUX_KLEIN_CPU_RUNNER_SHA256",
      FLUX_CPU_RUNNER_ARCHIVE_SHA256,
    ),
    executableBytes: resolvePositiveIntegerEnv(
      "MGT_FLUX_KLEIN_CPU_EXE_BYTES",
      FLUX_CPU_RUNNER_EXECUTABLE_BYTES,
    ),
    executableSha256: resolveSha256Env(
      "MGT_FLUX_KLEIN_CPU_EXE_SHA256",
      FLUX_CPU_RUNNER_EXECUTABLE_SHA256,
    ),
    fileName: FLUX_CPU_RUNNER_ASSET_FILE,
    label: `${FLUX_CPU_RUNNER_DIR}/${FLUX_CPU_RUNTIME_EXECUTABLE}`,
    url: `${baseUrl}/${FLUX_CPU_RUNNER_ASSET_FILE}`,
  };
}

function resolveLocalFluxCpuRunnerSource(): LocalFluxCpuRunnerSource | null {
  const explicit = process.env.MGT_FLUX_KLEIN_CPU_EXE;
  if (explicit && isExecutableFile(explicit)) {
    return { kind: "local", label: basename(explicit), path: explicit };
  }
  for (const toolsRoot of resolveFluxCpuToolsRoots()) {
    const path = join(
      toolsRoot,
      "mgt-flux-klein-cpu",
      FLUX_CPU_RUNTIME_EXECUTABLE,
    );
    if (isExecutableFile(path)) {
      return {
        kind: "local",
        label: `mgt-flux-klein-cpu/${FLUX_CPU_RUNTIME_EXECUTABLE}`,
        path,
      };
    }
  }
  return null;
}

async function ensureDownloadedFluxCpuRunner(options: {
  runtimeDir: string;
  managedDir: string;
  managedPath: string;
  source: RemoteFluxCpuRunnerSource;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  if (await isCurrentDownloadedFluxCpuRunner(options)) {
    options.onProgress?.({
      progressText: "Flux 실행 파일 캐시 사용",
      detail: options.source.label,
      progressMode: "log-only",
      installLogLine: `캐시된 CPU-only Flux 실행 파일을 사용합니다: ${options.source.label}`,
    });
    return options.managedPath;
  }
  const downloadsDir = join(options.runtimeDir, ".downloads", "flux-runners");
  const archivePath = join(downloadsDir, options.source.fileName);
  await downloadToFile({
    url: options.source.url,
    outputPath: archivePath,
    signal: options.signal,
    progressText: "Flux CPU 실행 파일 다운로드 중",
    label: options.source.fileName,
    expectedSha256: options.source.archiveSha256,
    expectedTotalBytes: options.source.archiveBytes,
    maximumBytes: MAX_REMOTE_RUNTIME_ARCHIVE_BYTES,
    onProgress: options.onProgress,
  });
  await rm(options.managedDir, { recursive: true, force: true });
  await extractZipSafely(archivePath, options.managedDir, options.signal);
  try {
    assertDownloadedExecutable(options.managedPath, options.source);
  } catch (error) {
    await rm(options.managedDir, { recursive: true, force: true });
    throw error;
  }
  await writeDownloadedRunnerMarker(options);
  options.onProgress?.({
    progressText: "Flux 실행 파일 준비 중",
    detail: options.source.label,
    progressMode: "log-only",
    installLogLine: `CPU-only Flux 실행 파일을 앱 데이터 캐시에 설치했습니다: ${options.source.label}`,
  });
  return options.managedPath;
}

async function isCurrentDownloadedFluxCpuRunner(options: {
  managedDir: string;
  managedPath: string;
  source: RemoteFluxCpuRunnerSource;
}): Promise<boolean> {
  try {
    assertDownloadedExecutable(options.managedPath, options.source);
    const marker = JSON.parse(
      await readFile(downloadedRunnerMarkerPath(options.managedDir), "utf8"),
    ) as {
      archiveBytes?: number;
      archiveSha256?: string;
      executableBytes?: number;
      executableSha256?: string;
      fileName?: string;
      url?: string;
    };
    return (
      marker.archiveBytes === options.source.archiveBytes &&
      marker.archiveSha256 === options.source.archiveSha256 &&
      marker.executableBytes === options.source.executableBytes &&
      marker.executableSha256 === options.source.executableSha256 &&
      marker.fileName === options.source.fileName &&
      marker.url === options.source.url
    );
  } catch (_error) {
    return false;
  }
}

function assertDownloadedExecutable(
  managedPath: string,
  source: RemoteFluxCpuRunnerSource,
): void {
  if (!isExecutableFile(managedPath)) {
    throw new Error(
      `${source.fileName}에서 ${FLUX_CPU_RUNTIME_EXECUTABLE}를 찾지 못했습니다.`,
    );
  }
  const bytes = statSync(managedPath).size;
  const sha256 = sha256FileSync(managedPath).toLowerCase();
  if (bytes !== source.executableBytes || sha256 !== source.executableSha256) {
    throw new Error(
      `${FLUX_CPU_RUNTIME_EXECUTABLE} 무결성 검증에 실패했습니다. expectedBytes=${source.executableBytes}, actualBytes=${bytes}, expectedSha256=${source.executableSha256}, actualSha256=${sha256}`,
    );
  }
}

async function writeDownloadedRunnerMarker(options: {
  managedDir: string;
  source: RemoteFluxCpuRunnerSource;
}): Promise<void> {
  await writeFile(
    downloadedRunnerMarkerPath(options.managedDir),
    `${JSON.stringify(
      {
        archiveBytes: options.source.archiveBytes,
        archiveSha256: options.source.archiveSha256,
        executableBytes: options.source.executableBytes,
        executableSha256: options.source.executableSha256,
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

function downloadedRunnerMarkerPath(managedDir: string): string {
  return join(managedDir, FLUX_CPU_RUNNER_MARKER);
}

function resolveFluxCpuToolsRoots(): string[] {
  if (process.env.MGT_FLUX_KLEIN_TOOLS_DIR) {
    return [process.env.MGT_FLUX_KLEIN_TOOLS_DIR];
  }
  return [
    process.resourcesPath ? join(process.resourcesPath, "tools") : null,
    join(process.cwd(), "tools"),
  ].filter((value): value is string => Boolean(value));
}

function resolvePositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveSha256Env(name: string, fallback: string): string {
  const value = process.env[name]?.trim().toLowerCase() ?? "";
  return /^[a-f0-9]{64}$/u.test(value) ? value : fallback.toLowerCase();
}
