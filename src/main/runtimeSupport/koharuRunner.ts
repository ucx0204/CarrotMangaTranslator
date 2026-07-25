import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const KOHARU_RUNNER_EXECUTABLE =
  process.platform === "win32"
    ? "mgt-koharu-inpaint-runner.exe"
    : "mgt-koharu-inpaint-runner";
export const KOHARU_RUNNER_DIRECTORY = "mgt-koharu-inpaint-runner";

export async function ensureManagedKoharuRunner(options: {
  runtimeDir: string;
  signal?: AbortSignal;
}): Promise<{ path: string; sourcePath: string }> {
  throwIfAborted(options.signal);
  const sourcePath = resolveKoharuRunnerSource();
  if (!sourcePath) {
    throw new Error(
      `Koharu 실행 파일을 찾을 수 없습니다: ${KOHARU_RUNNER_DIRECTORY}/${KOHARU_RUNNER_EXECUTABLE}`,
    );
  }

  const managedDir = join(options.runtimeDir, KOHARU_RUNNER_DIRECTORY);
  const managedPath = join(managedDir, KOHARU_RUNNER_EXECUTABLE);
  await mkdir(managedDir, { recursive: true });
  await copyFile(sourcePath, managedPath);
  if (process.platform !== "win32") {
    await chmod(managedPath, 0o755);
  }
  return { path: managedPath, sourcePath };
}

function resolveKoharuRunnerSource(): string | null {
  const explicit =
    process.env.MGT_KOHARU_RUNNER_EXE ?? process.env.MGT_KOHARU_INPAINT_EXE;
  if (explicit && existsSync(explicit)) {
    return explicit;
  }
  for (const toolsRoot of resolveKoharuRunnerToolsRoots()) {
    for (const candidate of runnerCandidates(toolsRoot)) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function runnerCandidates(toolsRoot: string): string[] {
  return [
    join(toolsRoot, KOHARU_RUNNER_DIRECTORY, KOHARU_RUNNER_EXECUTABLE),
    join(
      toolsRoot,
      KOHARU_RUNNER_DIRECTORY,
      "target",
      "aarch64-apple-darwin",
      "release",
      KOHARU_RUNNER_EXECUTABLE,
    ),
    join(
      toolsRoot,
      KOHARU_RUNNER_DIRECTORY,
      "target",
      "release",
      KOHARU_RUNNER_EXECUTABLE,
    ),
  ];
}

function resolveKoharuRunnerToolsRoots(): string[] {
  return [
    process.resourcesPath ? join(process.resourcesPath, "tools") : undefined,
    join(process.cwd(), "tools"),
  ].filter((value): value is string => Boolean(value));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}
