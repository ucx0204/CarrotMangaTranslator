import { existsSync } from "node:fs";
import { join } from "node:path";
import { tMain } from "../localization";
import {
  DEFAULT_AMD_GPU_TARGETS,
  FLUX_EMBED_PYTHON_VERSION,
  WINDOWS_MSVC_COMPILER_TARGET,
} from "./constants";
import type {
  FluxAssetProgress,
  FluxPythonBackend,
  PythonCommand,
} from "./types";
import { runCommand } from "./errors";
import { emitPythonInstallLog } from "./progress";
import {
  formatWindowsNativeBuildToolsMissingMessage,
  mergePathList,
  mergeWords,
  quoteCmakeArg,
  quoteShellToken,
  resolveWindowsNativeBuildEnv,
  resolveWindowsResourceCompiler,
  resolveWindowsRuntimeLibraryPaths,
  stageWindowsResourceCompiler,
  stageWindowsRuntimeLibraries,
  toCmakePath,
} from "./windowsBuildEnv";
import { buildBootstrapPythonEnv } from "./pythonBootstrap";
import { resolveWindowsRocmSdkPaths } from "./rocmSdkPaths";

export async function initializeWindowsRocmSdk(options: {
  python: PythonCommand;
  packageDir: string;
  runtimeDir: string;
  signal?: AbortSignal;
  onProgress?: (progress: FluxAssetProgress) => void;
}): Promise<void> {
  const env = buildTargetPythonEnv(
    options.runtimeDir,
    options.packageDir,
    "python-cpu",
    { requireNativeBuildEnv: false },
  );
  options.onProgress?.({
    progressText: "Flux ROCm SDK 초기화 중",
    detail: "rocm_sdk init",
    progressMode: "indeterminate",
    installLogLine:
      "ROCm wheel 안의 HIP/CMake 개발 파일을 실제 런타임 폴더로 펼칩니다.",
  });
  await runCommand(
    options.python.command,
    [...options.python.args, "-m", "rocm_sdk", "init"],
    {
      cwd: options.packageDir,
      signal: options.signal,
      env,
      onLine: (line) =>
        emitPythonInstallLog({ onProgress: options.onProgress }, line),
    },
  );
  await runCommand(
    options.python.command,
    [...options.python.args, "-m", "rocm_sdk", "path", "--cmake"],
    {
      cwd: options.packageDir,
      signal: options.signal,
      env,
      onLine: (line) =>
        emitPythonInstallLog({ onProgress: options.onProgress }, line),
    },
  );
  options.onProgress?.({
    progressText: tMain("inpainting.runtime.fluxRocmInitialized"),
    detail: tMain("inpainting.runtime.hipCmakeVerified"),
    progressMode: "log-only",
    installLogLine: "ROCm SDK 초기화와 CMake 경로 확인이 완료되었습니다.",
  });
}

export function buildTargetPythonEnv(
  runtimeDir: string,
  packageDir: string,
  backend: FluxPythonBackend = "python-cpu",
  options: { requireNativeBuildEnv?: boolean } = {},
): NodeJS.ProcessEnv {
  const pathEntries = [
    join(runtimeDir, "bootstrap-python", `python-${FLUX_EMBED_PYTHON_VERSION}`),
    join(
      runtimeDir,
      "bootstrap-python",
      `python-${FLUX_EMBED_PYTHON_VERSION}`,
      "Scripts",
    ),
    packageDir,
    join(packageDir, "Scripts"),
    join(packageDir, "torch", "lib"),
    join(packageDir, "rocm", "bin"),
    join(packageDir, "rocm_sdk", "bin"),
    join(packageDir, "Library", "bin"),
    join(packageDir, "_rocm_sdk_core", "bin"),
    join(packageDir, "_rocm_sdk_core", "lib", "llvm", "bin"),
    join(packageDir, "_rocm_sdk_devel", "bin"),
    join(packageDir, "_rocm_sdk_devel", "lib", "llvm", "bin"),
    join(packageDir, "_rocm_sdk_libraries_custom", "bin"),
    join(packageDir, "_rocm_sdk_libraries_custom", "bin", "hipblaslt"),
    join(
      packageDir,
      "_rocm_sdk_libraries_custom",
      "bin",
      "hipblaslt",
      "library",
    ),
  ];
  const env: NodeJS.ProcessEnv = {
    ...buildBootstrapPythonEnv(runtimeDir),
    PYTHONPATH: packageDir,
    PATH: [...pathEntries, process.env.PATH ?? ""]
      .filter(Boolean)
      .join(process.platform === "win32" ? ";" : ":"),
  };
  if (backend === "python-rocm") {
    applyRocmTargetPythonEnv(env, runtimeDir, packageDir, options);
  }
  return env;
}

type RocmTargetPythonEnvContext = {
  gpuTargets: string | null;
  hipCompilerFlags: string;
  nativeBuildEnv: ReturnType<typeof resolveWindowsNativeBuildEnv>;
  rcCompiler: string | null;
  rocmCmakePrefixList: string;
  rocmPaths: ReturnType<typeof resolveWindowsRocmSdkPaths>;
  runtimeLibraryCmakeValue: string;
  runtimeLibraryLdFlags: string;
};

function applyRocmTargetPythonEnv(
  env: NodeJS.ProcessEnv,
  runtimeDir: string,
  packageDir: string,
  options: { requireNativeBuildEnv?: boolean },
): void {
  const context = resolveRocmTargetPythonEnvContext(
    runtimeDir,
    packageDir,
    Boolean(options.requireNativeBuildEnv),
  );
  env.CMAKE_ARGS = buildRocmCmakeArgs(env, context).join(" ");
  env.CFLAGS = mergeWords(
    env.CFLAGS,
    `--target=${WINDOWS_MSVC_COMPILER_TARGET}`,
  );
  env.CXXFLAGS = mergeWords(
    env.CXXFLAGS,
    `--target=${WINDOWS_MSVC_COMPILER_TARGET}`,
    context.hipCompilerFlags,
  );
  env.LDFLAGS = mergeWords(env.LDFLAGS, context.runtimeLibraryLdFlags);
  env.FORCE_CMAKE = "1";
  env.CMAKE_GENERATOR = env.CMAKE_GENERATOR || "Ninja";
  applyNativeBuildEnv(env, runtimeDir, context);
  applyRocmCompilerEnv(env, context);
}

function resolveRocmTargetPythonEnvContext(
  runtimeDir: string,
  packageDir: string,
  requireNativeBuildEnv: boolean,
): RocmTargetPythonEnvContext {
  const rocmPaths = resolveWindowsRocmSdkPaths(packageDir);
  const nativeBuildEnv = resolveWindowsNativeBuildEnv();
  if (!nativeBuildEnv && requireNativeBuildEnv) {
    throw new Error(formatWindowsNativeBuildToolsMissingMessage());
  }
  const rcCompiler = stageWindowsResourceCompiler(
    runtimeDir,
    resolveWindowsResourceCompiler(rocmPaths, nativeBuildEnv),
  );
  const runtimeLibraryPaths = nativeBuildEnv
    ? resolveWindowsRuntimeLibraryPaths(nativeBuildEnv.libPaths)
    : [];
  const stagedRuntimeLibraryPaths = stageWindowsRuntimeLibraries(
    runtimeDir,
    runtimeLibraryPaths,
  );
  return {
    gpuTargets: resolveAmdGpuTargets(),
    hipCompilerFlags: buildHipCompilerFlags(rocmPaths),
    nativeBuildEnv,
    rcCompiler,
    rocmCmakePrefixList: rocmPaths.cmakePrefixPaths.map(toCmakePath).join(";"),
    rocmPaths,
    runtimeLibraryCmakeValue: stagedRuntimeLibraryPaths
      .map((item) => quoteShellToken(toCmakePath(item)))
      .join(" "),
    runtimeLibraryLdFlags: stagedRuntimeLibraryPaths
      .map((item) => quoteShellToken(toCmakePath(item)))
      .join(" "),
  };
}

function buildHipCompilerFlags(
  rocmPaths: ReturnType<typeof resolveWindowsRocmSdkPaths>,
): string {
  return [
    `--rocm-device-lib-path=${toCmakePath(rocmPaths.deviceLibPath)}`,
    `--hip-device-lib-path=${toCmakePath(rocmPaths.deviceLibPath)}`,
    `--hip-path=${toCmakePath(rocmPaths.hipRoot)}`,
  ]
    .map(quoteShellToken)
    .join(" ");
}

function buildRocmCmakeArgs(
  env: NodeJS.ProcessEnv,
  context: RocmTargetPythonEnvContext,
): string[] {
  const { gpuTargets, nativeBuildEnv, rcCompiler, rocmPaths } = context;
  return [
    env.CMAKE_ARGS,
    `-DCMAKE_C_COMPILER:FILEPATH=${toCmakePath(rocmPaths.clang)}`,
    `-DCMAKE_CXX_COMPILER:FILEPATH=${toCmakePath(rocmPaths.clangxx)}`,
    rcCompiler ? `-DCMAKE_RC_COMPILER:FILEPATH=${toCmakePath(rcCompiler)}` : "",
    existsSync(rocmPaths.llvmMt)
      ? `-DCMAKE_MT:FILEPATH=${toCmakePath(rocmPaths.llvmMt)}`
      : "",
    ...buildWindowsSdkCmakeArgs(nativeBuildEnv),
    `-DCMAKE_C_COMPILER_TARGET=${WINDOWS_MSVC_COMPILER_TARGET}`,
    `-DCMAKE_CXX_COMPILER_TARGET=${WINDOWS_MSVC_COMPILER_TARGET}`,
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL",
    ...buildRuntimeLibraryCmakeArgs(context.runtimeLibraryCmakeValue),
    quoteCmakeArg(`-DCMAKE_PREFIX_PATH:STRING=${context.rocmCmakePrefixList}`),
    quoteCmakeArg(`-Dhip_DIR:PATH=${toCmakePath(rocmPaths.hipCmakeDir)}`),
    quoteCmakeArg(`-DHIP_PATH:PATH=${toCmakePath(rocmPaths.hipRoot)}`),
    quoteCmakeArg(`-DROCM_PATH:PATH=${toCmakePath(rocmPaths.rocmRoot)}`),
    quoteCmakeArg(
      `-DHIP_DEVICE_LIB_PATH:PATH=${toCmakePath(rocmPaths.deviceLibPath)}`,
    ),
    quoteCmakeArg(
      `-DROCM_DEVICE_LIB_PATH:PATH=${toCmakePath(rocmPaths.deviceLibPath)}`,
    ),
    quoteCmakeArg(`-DCMAKE_HIP_FLAGS:STRING=${context.hipCompilerFlags}`),
    "-DHIP_PLATFORM=amd",
    "-DCMAKE_TRY_COMPILE_CONFIGURATION=Release",
    "-DSD_HIPBLAS=ON",
    "-DGGML_OPENMP=OFF",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
    gpuTargets ? `-DGPU_TARGETS=${gpuTargets}` : "",
    gpuTargets ? `-DAMDGPU_TARGETS=${gpuTargets}` : "",
  ].filter((arg): arg is string => Boolean(arg));
}

function buildWindowsSdkCmakeArgs(
  nativeBuildEnv: ReturnType<typeof resolveWindowsNativeBuildEnv>,
): string[] {
  return [
    nativeBuildEnv?.sdkVersion
      ? `-DCMAKE_SYSTEM_VERSION=${nativeBuildEnv.sdkVersion}`
      : "",
    nativeBuildEnv?.sdkVersion
      ? `-DCMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION=${nativeBuildEnv.sdkVersion}`
      : "",
  ];
}

function buildRuntimeLibraryCmakeArgs(
  runtimeLibraryCmakeValue: string,
): string[] {
  if (!runtimeLibraryCmakeValue) {
    return [];
  }
  return [
    quoteCmakeArg(
      `-DCMAKE_C_STANDARD_LIBRARIES:STRING=${runtimeLibraryCmakeValue}`,
    ),
    quoteCmakeArg(
      `-DCMAKE_CXX_STANDARD_LIBRARIES:STRING=${runtimeLibraryCmakeValue}`,
    ),
  ];
}

function applyNativeBuildEnv(
  env: NodeJS.ProcessEnv,
  runtimeDir: string,
  { nativeBuildEnv }: RocmTargetPythonEnvContext,
): void {
  if (!nativeBuildEnv) {
    return;
  }
  env.PATH = mergePathList(nativeBuildEnv.pathEntries, env.PATH);
  env.INCLUDE = mergePathList(nativeBuildEnv.includePaths);
  env.LIB = mergePathList(
    join(runtimeDir, "native-libs"),
    nativeBuildEnv.libPaths,
  );
  env.LIBPATH = mergePathList(
    join(runtimeDir, "native-libs"),
    nativeBuildEnv.libPaths,
  );
}

function applyRocmCompilerEnv(
  env: NodeJS.ProcessEnv,
  context: RocmTargetPythonEnvContext,
): void {
  const { gpuTargets, rcCompiler, rocmPaths } = context;
  env.CC = env.CC || rocmPaths.clang;
  env.CXX = env.CXX || rocmPaths.clangxx;
  if (rcCompiler) {
    env.RC = env.RC || rcCompiler;
  }
  env.ROCM_PATH = env.ROCM_PATH || rocmPaths.rocmRoot;
  env.HIP_PATH = env.HIP_PATH || rocmPaths.hipRoot;
  env.HIP_DEVICE_LIB_PATH = env.HIP_DEVICE_LIB_PATH || rocmPaths.deviceLibPath;
  env.ROCM_DEVICE_LIB_PATH =
    env.ROCM_DEVICE_LIB_PATH || rocmPaths.deviceLibPath;
  env.CMAKE_PREFIX_PATH = mergePathList(
    env.CMAKE_PREFIX_PATH,
    rocmPaths.cmakePrefixPaths,
  );
  if (gpuTargets) {
    env.GPU_TARGETS = env.GPU_TARGETS || gpuTargets;
    env.AMDGPU_TARGETS = env.AMDGPU_TARGETS || gpuTargets;
  }
}

function resolveAmdGpuTargets(): string | null {
  const value =
    process.env.MANGA_TRANSLATOR_AMDGPU_TARGETS ??
    process.env.MGT_AMDGPU_TARGETS ??
    process.env.AMDGPU_TARGETS ??
    process.env.GPU_TARGETS ??
    "";
  const normalized = value
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(";");
  return normalized || DEFAULT_AMD_GPU_TARGETS.join(";");
}
