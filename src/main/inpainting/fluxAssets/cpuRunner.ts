import { chmod, copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { FLUX_CPU_RUNNER_DIR, FLUX_CPU_RUNTIME_EXECUTABLE } from "./constants";
import { throwIfAborted } from "./errors";
import {
  isExecutableFile,
  sha256FileSync,
} from "../../runtimeSupport/fileProbe";
import type { FluxAssetProgress } from "./types";

type FluxCpuRunnerSource = {
  label: string;
  path: string;
};

export async function ensureManagedFluxCpuRunner(options: {
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<string> {
  const source = resolveFluxCpuRunnerSource();
  if (!source) {
    throw new Error(
      `${FLUX_CPU_RUNNER_DIR}/${FLUX_CPU_RUNTIME_EXECUTABLE}를 찾지 못했습니다. ` +
        "설치 파일에 CPU-only Flux 실행 파일이 포함되어 있어야 합니다. 개발 환경에서는 npm run build:flux-cpu-runner를 실행하거나 MGT_FLUX_KLEIN_CPU_EXE로 경로를 지정하세요.",
    );
  }
  const managedDir = join(options.runtimeDir, FLUX_CPU_RUNNER_DIR);
  const managedPath = join(managedDir, FLUX_CPU_RUNTIME_EXECUTABLE);
  throwIfAborted(options.signal);
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
  options.onProgress?.({
    progressText: "Flux 실행 파일 준비 중",
    detail: source.label,
    progressMode: "log-only",
    installLogLine: `Flux 실행 파일을 앱 데이터 캐시에 갱신했습니다: ${source.label}`,
  });
  return managedPath;
}

function resolveFluxCpuRunnerSource(): FluxCpuRunnerSource | null {
  const explicit = process.env.MGT_FLUX_KLEIN_CPU_EXE;
  if (explicit && isExecutableFile(explicit)) {
    return { label: basename(explicit), path: explicit };
  }
  for (const toolsRoot of resolveFluxCpuToolsRoots()) {
    const path = join(
      toolsRoot,
      FLUX_CPU_RUNNER_DIR,
      FLUX_CPU_RUNTIME_EXECUTABLE,
    );
    if (isExecutableFile(path)) {
      return {
        label: `${FLUX_CPU_RUNNER_DIR}/${FLUX_CPU_RUNTIME_EXECUTABLE}`,
        path,
      };
    }
  }
  return null;
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
