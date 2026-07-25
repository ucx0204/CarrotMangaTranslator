import { dirname, join, resolve } from "node:path";
import {
  directoryExists,
  fileExists,
  findFilesRecursive,
  findFirstFileRecursive,
  safeReadDir,
  uniqueExistingDirs,
} from "../../runtimeSupport/fileProbe";

export function resolveWindowsRocmSdkPaths(packageDir: string): {
  coreRoot: string;
  develRoot: string;
  librariesRoot: string;
  rocmRoot: string;
  hipRoot: string;
  hipCmakeDir: string;
  cmakePrefixPaths: string[];
  clang: string;
  clangxx: string;
  llvmRc: string;
  llvmMt: string;
  deviceLibPath: string;
} {
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
    llvmRc: join(llvmBin, "llvm-rc.exe"),
    llvmMt: join(llvmBin, "llvm-mt.exe"),
    deviceLibPath,
  };
}

function resolveRocmDeviceLibPath(
  packageDir: string,
  coreRoot: string,
  develRoot: string,
): string {
  const candidates = [
    join(coreRoot, "lib", "llvm", "amdgcn", "bitcode"),
    join(develRoot, "lib", "llvm", "amdgcn", "bitcode"),
    join(packageDir, "lib", "llvm", "amdgcn", "bitcode"),
  ];
  for (const candidate of candidates) {
    if (fileExists(join(candidate, "ocml.bc"))) {
      return candidate;
    }
  }
  const found = findFirstFileRecursive(packageDir, new Set(["ocml.bc"]), 8);
  if (found) {
    return dirname(found);
  }
  return candidates[0];
}

function resolveCmakePackageDir(
  packageDir: string,
  packageName: string,
  candidates: string[],
): string {
  const configNames = [
    `${packageName}-config.cmake`,
    `${packageName}Config.cmake`,
  ];
  for (const candidate of candidates) {
    if (configNames.some((name) => fileExists(join(candidate, name)))) {
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

function resolveRocmRootForCmakePackage(
  cmakeDir: string,
  fallbackRoot: string,
): string {
  const normalized = resolve(cmakeDir).replace(/\\/g, "/");
  const markerIndex = normalized.toLowerCase().lastIndexOf("/lib/cmake");
  return markerIndex > 0 ? normalized.slice(0, markerIndex) : fallbackRoot;
}

function formatMissingCmakePackageMessage(
  packageDir: string,
  packageName: string,
  configNames: string[],
  candidates: string[],
): string {
  return [
    `ROCm CMake package "${packageName}" was not found after ROCm SDK initialization.`,
    `Expected one of: ${configNames.join(", ")}`,
    "Candidate directories:",
    ...candidates.map(
      (item) =>
        `  - ${item} ${directoryExists(item) ? "(exists)" : "(missing)"}`,
    ),
    formatRocmTreeSummary(packageDir),
  ].join("\n");
}

function formatRocmTreeSummary(packageDir: string): string {
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
    if (!directoryExists(root)) {
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
