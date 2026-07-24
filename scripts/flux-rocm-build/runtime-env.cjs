/**
 * @typedef {{ line(text: string): void; raw(text: string): void; close(): void }} BuildLogger
 * @typedef {{ sdkVersion?: string; pathEntries: string[]; includePaths: string[]; libPaths: string[] }} NativeBuildEnv
 * @typedef {{ coreRoot: string; develRoot: string; librariesRoot: string; rocmRoot: string; hipRoot: string; hipCmakeDir: string; cmakePrefixPaths: string[]; clang: string; clangxx: string; deviceLibPath: string; llvmRc: string; llvmMt: string }} RocmPaths
 */
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { pythonVersion, windowsMsvcCompilerTarget } = require("./config.cjs");
const { quoteArg, quoteCmakeArg } = require("./build-utils.cjs");
const {
  resolveWindowsResourceCompiler,
  resolveWindowsRocmSdkPaths,
  stageWindowsResourceCompiler,
  stageWindowsRuntimeLibraries,
  validateWindowsRocmSdkPaths,
} = require("./rocm-sdk.cjs");
const {
  isFile,
  mergePathList,
  mergeWords,
  resolveWindowsRuntimeLibraryPaths,
  toCmakePath,
} = require("./windows-native-tools.cjs");

/**
 * @param {string} runtimeDir
 * @param {string} packageDir
 * @param {NativeBuildEnv} nativeBuildEnv
 * @param {string} gpuTargets
 * @param {BuildLogger} logger
 * @returns {NodeJS.ProcessEnv}
 */
function buildRuntimeEnv(
  runtimeDir,
  packageDir,
  nativeBuildEnv,
  gpuTargets,
  logger,
) {
  const rocmPaths = resolveWindowsRocmSdkPaths(packageDir);
  const rcCompiler = stageWindowsResourceCompiler(
    runtimeDir,
    resolveWindowsResourceCompiler(rocmPaths, nativeBuildEnv),
  );
  validateWindowsRocmSdkPaths(rocmPaths, packageDir, logger, rcCompiler);
  const runtimeLibraryPaths = resolveWindowsRuntimeLibraryPaths(
    nativeBuildEnv.libPaths,
  );
  const stagedRuntimeLibraryPaths = stageWindowsRuntimeLibraries(
    runtimeDir,
    runtimeLibraryPaths,
  );
  const runtimeLibraryCmakeValue = stagedRuntimeLibraryPaths
    .map((item) => quoteArg(toCmakePath(item)))
    .join(" ");
  const runtimeLibraryLdFlags = stagedRuntimeLibraryPaths
    .map((item) => quoteArg(toCmakePath(item)))
    .join(" ");
  const rocmCmakePrefixList = rocmPaths.cmakePrefixPaths
    .map(toCmakePath)
    .join(";");
  const hipCompilerFlags = [
    `--rocm-device-lib-path=${toCmakePath(rocmPaths.deviceLibPath)}`,
    `--hip-device-lib-path=${toCmakePath(rocmPaths.deviceLibPath)}`,
    `--hip-path=${toCmakePath(rocmPaths.hipRoot)}`,
  ]
    .map(quoteArg)
    .join(" ");
  const pathEntries = buildRuntimePathEntries(runtimeDir, packageDir);
  const cmakeArgs = buildRuntimeCmakeArgs({
    rocmPaths,
    rcCompiler,
    nativeBuildEnv,
    gpuTargets,
    runtimeLibraryCmakeValue,
    rocmCmakePrefixList,
    hipCompilerFlags,
  });
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: packageDir,
    PIP_CACHE_DIR: join(runtimeDir, "pip-cache"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    TMP: join(runtimeDir, "t"),
    TEMP: join(runtimeDir, "t"),
    PATH: mergePathList(
      nativeBuildEnv.pathEntries,
      pathEntries,
      process.env.PATH,
    ),
    INCLUDE: mergePathList(nativeBuildEnv.includePaths),
    LIB: mergePathList(
      join(runtimeDir, "native-libs"),
      nativeBuildEnv.libPaths,
    ),
    LIBPATH: mergePathList(
      join(runtimeDir, "native-libs"),
      nativeBuildEnv.libPaths,
    ),
    CMAKE_ARGS: mergeWords(process.env.CMAKE_ARGS, cmakeArgs.join(" ")),
    CFLAGS: mergeWords(
      process.env.CFLAGS,
      `--target=${windowsMsvcCompilerTarget}`,
    ),
    CXXFLAGS: mergeWords(
      process.env.CXXFLAGS,
      `--target=${windowsMsvcCompilerTarget}`,
      hipCompilerFlags,
    ),
    LDFLAGS: mergeWords(process.env.LDFLAGS, runtimeLibraryLdFlags),
    FORCE_CMAKE: "1",
    CMAKE_GENERATOR: process.env.CMAKE_GENERATOR || "Ninja",
    CC: process.env.CC || rocmPaths.clang,
    CXX: process.env.CXX || rocmPaths.clangxx,
    RC: process.env.RC || rcCompiler || undefined,
    ROCM_PATH: process.env.ROCM_PATH || rocmPaths.rocmRoot,
    HIP_PATH: process.env.HIP_PATH || rocmPaths.hipRoot,
    HIP_DEVICE_LIB_PATH:
      process.env.HIP_DEVICE_LIB_PATH || rocmPaths.deviceLibPath,
    ROCM_DEVICE_LIB_PATH:
      process.env.ROCM_DEVICE_LIB_PATH || rocmPaths.deviceLibPath,
    CMAKE_PREFIX_PATH: mergePathList(
      process.env.CMAKE_PREFIX_PATH,
      rocmPaths.cmakePrefixPaths,
    ),
  };
  if (gpuTargets) {
    env.GPU_TARGETS = gpuTargets;
    env.AMDGPU_TARGETS = gpuTargets;
  }
  mkdirSync(String(env.TMP), { recursive: true });
  mkdirSync(String(env.PIP_CACHE_DIR), { recursive: true });
  return env;
}

/** @param {string} runtimeDir @param {string} packageDir */
function buildRuntimePathEntries(runtimeDir, packageDir) {
  return [
    join(runtimeDir, "bootstrap-python", `python-${pythonVersion}`),
    join(runtimeDir, "bootstrap-python", `python-${pythonVersion}`, "Scripts"),
    packageDir,
    join(packageDir, "Scripts"),
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
}

/**
 * @param {{ rocmPaths: RocmPaths; rcCompiler: string | null; nativeBuildEnv: NativeBuildEnv; gpuTargets: string; runtimeLibraryCmakeValue: string; rocmCmakePrefixList: string; hipCompilerFlags: string }} input
 */
function buildRuntimeCmakeArgs(input) {
  const {
    rocmPaths,
    rcCompiler,
    nativeBuildEnv,
    gpuTargets,
    runtimeLibraryCmakeValue,
    rocmCmakePrefixList,
    hipCompilerFlags,
  } = input;
  return [
    `-DCMAKE_C_COMPILER:FILEPATH=${toCmakePath(rocmPaths.clang)}`,
    `-DCMAKE_CXX_COMPILER:FILEPATH=${toCmakePath(rocmPaths.clangxx)}`,
    `-DCMAKE_RC_COMPILER:FILEPATH=${toCmakePath(rcCompiler)}`,
    isFile(rocmPaths.llvmMt)
      ? `-DCMAKE_MT:FILEPATH=${toCmakePath(rocmPaths.llvmMt)}`
      : "",
    nativeBuildEnv.sdkVersion
      ? `-DCMAKE_SYSTEM_VERSION=${nativeBuildEnv.sdkVersion}`
      : "",
    nativeBuildEnv.sdkVersion
      ? `-DCMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION=${nativeBuildEnv.sdkVersion}`
      : "",
    `-DCMAKE_C_COMPILER_TARGET=${windowsMsvcCompilerTarget}`,
    `-DCMAKE_CXX_COMPILER_TARGET=${windowsMsvcCompilerTarget}`,
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL",
    quoteCmakeArg(
      `-DCMAKE_C_STANDARD_LIBRARIES:STRING=${runtimeLibraryCmakeValue}`,
    ),
    quoteCmakeArg(
      `-DCMAKE_CXX_STANDARD_LIBRARIES:STRING=${runtimeLibraryCmakeValue}`,
    ),
    quoteCmakeArg(`-DCMAKE_PREFIX_PATH:STRING=${rocmCmakePrefixList}`),
    quoteCmakeArg(`-Dhip_DIR:PATH=${toCmakePath(rocmPaths.hipCmakeDir)}`),
    quoteCmakeArg(`-DHIP_PATH:PATH=${toCmakePath(rocmPaths.hipRoot)}`),
    quoteCmakeArg(`-DROCM_PATH:PATH=${toCmakePath(rocmPaths.rocmRoot)}`),
    quoteCmakeArg(
      `-DHIP_DEVICE_LIB_PATH:PATH=${toCmakePath(rocmPaths.deviceLibPath)}`,
    ),
    quoteCmakeArg(
      `-DROCM_DEVICE_LIB_PATH:PATH=${toCmakePath(rocmPaths.deviceLibPath)}`,
    ),
    quoteCmakeArg(`-DCMAKE_HIP_FLAGS:STRING=${hipCompilerFlags}`),
    "-DHIP_PLATFORM=amd",
    "-DCMAKE_TRY_COMPILE_CONFIGURATION=Release",
    "-DSD_HIPBLAS=ON",
    "-DGGML_OPENMP=OFF",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON",
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
    gpuTargets ? `-DGPU_TARGETS=${gpuTargets}` : "",
    gpuTargets ? `-DAMDGPU_TARGETS=${gpuTargets}` : "",
  ].filter(Boolean);
}

module.exports = { buildRuntimeEnv };
