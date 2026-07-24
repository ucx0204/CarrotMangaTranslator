/** @typedef {{ sdkVersion?: string; pathEntries: string[]; includePaths: string[]; libPaths: string[] }} NativeBuildEnv */
/** @typedef {{ line(text: string): void; raw(text: string): void; close(): void }} BuildLogger */
/** @typedef {{ coreRoot: string; develRoot: string; librariesRoot: string; rocmRoot: string; hipRoot: string; hipCmakeDir: string; cmakePrefixPaths: string[]; clang: string; clangxx: string; deviceLibPath: string; llvmRc: string; llvmMt: string }} RocmPaths */
const { copyFileSync, mkdirSync, readdirSync } = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");
const {
  findFileInPathList,
  isDirectory,
  isFile,
  uniqueExistingDirs,
} = require("./windows-native-tools.cjs");

/**
 * @param {string} packageDir
 * @returns {RocmPaths}
 */
function resolveWindowsRocmSdkPaths(packageDir) {
  const coreRoot = join(packageDir, "_rocm_sdk_core");
  const develRoot = join(packageDir, "_rocm_sdk_devel");
  const librariesRoot = join(packageDir, "_rocm_sdk_libraries_custom");
  const llvmBin = join(coreRoot, "lib", "llvm", "bin");
  const deviceLibPath = resolveRocmDeviceLibPath(
    packageDir,
    coreRoot,
    develRoot,
  );
  const hipCmakeDir = resolveCmakePackageDir(packageDir, "hip", [
    join(develRoot, "lib", "cmake", "hip"),
    join(coreRoot, "lib", "cmake", "hip"),
    join(librariesRoot, "lib", "cmake", "hip"),
    join(packageDir, "lib", "cmake", "hip"),
  ]);
  const hipRoot = resolveRocmRootForCmakePackage(hipCmakeDir, develRoot);
  const cmakePrefixPaths = uniqueExistingDirs([
    coreRoot,
    develRoot,
    librariesRoot,
    join(coreRoot, "lib", "cmake"),
    join(develRoot, "lib", "cmake"),
    join(librariesRoot, "lib", "cmake"),
    hipRoot,
    hipCmakeDir,
  ]);
  return {
    coreRoot,
    develRoot,
    librariesRoot,
    rocmRoot: develRoot,
    hipRoot,
    hipCmakeDir,
    cmakePrefixPaths,
    clang: join(llvmBin, "clang.exe"),
    clangxx: join(llvmBin, "clang++.exe"),
    deviceLibPath,
    llvmRc: join(llvmBin, "llvm-rc.exe"),
    llvmMt: join(llvmBin, "llvm-mt.exe"),
  };
}

/**
 * @param {string} packageDir
 * @param {string} coreRoot
 * @param {string} develRoot
 * @returns {string}
 */
function resolveRocmDeviceLibPath(packageDir, coreRoot, develRoot) {
  const candidates = [
    join(coreRoot, "lib", "llvm", "amdgcn", "bitcode"),
    join(develRoot, "lib", "llvm", "amdgcn", "bitcode"),
    join(packageDir, "lib", "llvm", "amdgcn", "bitcode"),
  ];
  for (const candidate of candidates) {
    if (isFile(join(candidate, "ocml.bc"))) {
      return candidate;
    }
  }
  const found = findFirstFileRecursive(packageDir, new Set(["ocml.bc"]), 8);
  if (found) {
    return dirname(found);
  }
  return candidates[0];
}

/**
 * @param {string} packageDir
 * @param {string} packageName
 * @param {string[]} candidates
 * @returns {string}
 */
function resolveCmakePackageDir(packageDir, packageName, candidates) {
  const configNames = [
    `${packageName}-config.cmake`,
    `${packageName}Config.cmake`,
  ];
  for (const candidate of candidates) {
    if (configNames.some((name) => isFile(join(candidate, name)))) {
      return candidate;
    }
  }
  const found = findFirstFileRecursive(
    packageDir,
    new Set(configNames.map((name) => name.toLowerCase())),
    8,
  );
  if (found) {
    return dirname(found);
  }
  throw new Error(
    formatMissingCmakePackageMessage(
      packageDir,
      packageName,
      configNames,
      candidates,
    ),
  );
}

/**
 * @param {string} cmakeDir
 * @param {string} fallbackRoot
 * @returns {string}
 */
function resolveRocmRootForCmakePackage(cmakeDir, fallbackRoot) {
  const normalized = resolve(cmakeDir).replace(/\\/g, "/");
  const markerIndex = normalized.toLowerCase().lastIndexOf("/lib/cmake");
  return markerIndex > 0 ? normalized.slice(0, markerIndex) : fallbackRoot;
}

/**
 * @param {RocmPaths} rocmPaths
 * @param {NativeBuildEnv} nativeBuildEnv
 * @returns {string | null}
 */
function resolveWindowsResourceCompiler(rocmPaths, nativeBuildEnv) {
  if (isFile(rocmPaths.llvmRc)) {
    return rocmPaths.llvmRc;
  }
  return findFileInPathList(nativeBuildEnv.pathEntries, "rc.exe");
}

/**
 * @param {string} runtimeDir
 * @param {string | null} rcCompiler
 * @returns {string | null}
 */
function stageWindowsResourceCompiler(runtimeDir, rcCompiler) {
  if (!rcCompiler) {
    return rcCompiler;
  }
  const stagedDir = join(runtimeDir, "native-tools");
  const stagedPath = join(stagedDir, "rc.exe");
  mkdirSync(stagedDir, { recursive: true });
  copyFileSync(rcCompiler, stagedPath);
  return stagedPath;
}

/**
 * @param {string} runtimeDir
 * @param {string[]} libraryPaths
 * @returns {string[]}
 */
function stageWindowsRuntimeLibraries(runtimeDir, libraryPaths) {
  if (!libraryPaths.length) {
    return [];
  }
  const stagedDir = join(runtimeDir, "native-libs");
  mkdirSync(stagedDir, { recursive: true });
  return libraryPaths.map((libraryPath) => {
    const stagedPath = join(stagedDir, basename(libraryPath));
    copyFileSync(libraryPath, stagedPath);
    return stagedPath;
  });
}

/**
 * @param {RocmPaths} rocmPaths
 * @param {string} packageDir
 * @param {BuildLogger | null} logger
 * @param {string | null} rcCompiler
 * @returns {void}
 */
function validateWindowsRocmSdkPaths(
  rocmPaths,
  packageDir,
  logger,
  rcCompiler,
) {
  /** @type {[string, string | null][]} */
  const requiredFiles = [
    ["ROCm clang", rocmPaths.clang],
    ["ROCm clang++", rocmPaths.clangxx],
    ["ROCm device library", join(rocmPaths.deviceLibPath, "ocml.bc")],
    ["Windows resource compiler", rcCompiler],
  ];
  for (const [label, filePath] of requiredFiles) {
    if (!isFile(filePath)) {
      throw new Error(
        `${label} was not found: ${filePath}\n${formatRocmTreeSummary(packageDir)}`,
      );
    }
  }
  if (
    !["hip-config.cmake", "hipConfig.cmake"].some((fileName) =>
      isFile(join(rocmPaths.hipCmakeDir, fileName)),
    )
  ) {
    throw new Error(
      `HIP CMake config was not found in ${rocmPaths.hipCmakeDir}\n${formatRocmTreeSummary(packageDir)}`,
    );
  }
  if (logger) {
    logger.line(`ROCm clang: ${rocmPaths.clang}`);
    logger.line(`ROCm device library path: ${rocmPaths.deviceLibPath}`);
    logger.line(`ROCm HIP CMake config: ${rocmPaths.hipCmakeDir}`);
    logger.line(
      `ROCm CMake prefix paths: ${rocmPaths.cmakePrefixPaths.join(";")}`,
    );
  }
}

/**
 * @param {string} packageDir
 * @param {string} packageName
 * @param {string[]} configNames
 * @param {string[]} candidates
 * @returns {string}
 */
function formatMissingCmakePackageMessage(
  packageDir,
  packageName,
  configNames,
  candidates,
) {
  return [
    `ROCm CMake package "${packageName}" was not found after ROCm SDK installation.`,
    `Expected one of: ${configNames.join(", ")}`,
    "Candidate directories:",
    ...candidates.map(
      (item) => `  - ${item} ${isDirectory(item) ? "(exists)" : "(missing)"}`,
    ),
    formatRocmTreeSummary(packageDir),
  ].join("\n");
}

/**
 * @param {string} packageDir
 * @returns {string}
 */
function formatRocmTreeSummary(packageDir) {
  const roots = [
    packageDir,
    join(packageDir, "_rocm_sdk_core"),
    join(packageDir, "_rocm_sdk_devel"),
    join(packageDir, "_rocm_sdk_libraries_custom"),
    join(packageDir, "rocm"),
    join(packageDir, "rocm_sdk"),
  ];
  const lines = ["ROCm package tree summary:"];
  for (const root of roots) {
    if (!isDirectory(root)) {
      lines.push(`  - ${root}: missing`);
      continue;
    }
    lines.push(`  - ${root}: exists`);
    const entries = safeReadDir(root)
      .slice(0, 30)
      .map((entry) => entry.name)
      .join(", ");
    if (entries) {
      lines.push(`    entries: ${entries}`);
    }
  }
  const cmakeHits = findFilesRecursive(
    packageDir,
    (entry) => {
      const lower = entry.name.toLowerCase();
      return (
        entry.isFile() &&
        (lower.includes("hip") || lower.includes("rocm")) &&
        lower.endsWith(".cmake")
      );
    },
    9,
    60,
  );
  if (cmakeHits.length) {
    lines.push("Nearby ROCm/HIP CMake files:");
    for (const hit of cmakeHits) {
      lines.push(`  - ${hit}`);
    }
  } else {
    lines.push("Nearby ROCm/HIP CMake files: none found");
  }
  return lines.join("\n");
}

/** @param {string} dir @returns {import("node:fs").Dirent[]} */
function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
}

/**
 * @param {string} root
 * @param {Set<string>} lowerCaseNames
 * @param {number} maxDepth
 * @returns {string | null}
 */
function findFirstFileRecursive(root, lowerCaseNames, maxDepth) {
  if (!isDirectory(root)) {
    return null;
  }
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const { dir, depth } = current;
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && lowerCaseNames.has(entry.name.toLowerCase())) {
        return fullPath;
      }
      if (
        entry.isDirectory() &&
        depth < maxDepth &&
        !["__pycache__", ".git"].includes(entry.name)
      ) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }
  return null;
}

/**
 * @param {string} root
 * @param {(entry: import("node:fs").Dirent, fullPath: string) => boolean} predicate
 * @param {number} maxDepth
 * @param {number} limit
 * @returns {string[]}
 */
function findFilesRecursive(root, predicate, maxDepth, limit) {
  if (!isDirectory(root)) {
    return [];
  }
  /** @type {string[]} */
  const results = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length && results.length < limit) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const { dir, depth } = current;
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (predicate(entry, fullPath)) {
        results.push(fullPath);
      }
      if (results.length >= limit) break;
      if (
        entry.isDirectory() &&
        depth < maxDepth &&
        !["__pycache__", ".git"].includes(entry.name)
      ) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      }
    }
  }
  return results;
}

module.exports = {
  resolveWindowsResourceCompiler,
  resolveWindowsRocmSdkPaths,
  stageWindowsResourceCompiler,
  stageWindowsRuntimeLibraries,
  validateWindowsRocmSdkPaths,
};
