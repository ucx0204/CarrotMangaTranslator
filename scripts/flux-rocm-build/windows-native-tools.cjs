/**
 * @typedef {{ sdkVersion?: string; pathEntries: string[]; includePaths: string[]; libPaths: string[] }} NativeBuildEnv
 * @typedef {{ root: string; version?: string; umLibPath: string; ucrtLibPath: string; includePaths: string[]; binPath?: string }} WindowsSdkLayout
 * @typedef {{ root: string; version?: string; libPath: string; includePath: string; binPath?: string }} MsvcToolsLayout
 */

const { readdirSync } = require("node:fs");
const { delimiter, join, resolve } = require("node:path");
const {
  isDirectory,
  isFile,
  isPathInside,
  toCmakePath,
} = require("./path-utils.cjs");

const windowsDynamicRuntimeLibNames = [
  "msvcrt.lib",
  "msvcprt.lib",
  "vcruntime.lib",
  "ucrt.lib",
  "oldnames.lib",
];
const windowsSystemImportLibNames = [
  "kernel32.lib",
  "user32.lib",
  "gdi32.lib",
  "winspool.lib",
  "shell32.lib",
  "ole32.lib",
  "oleaut32.lib",
  "uuid.lib",
  "comdlg32.lib",
  "advapi32.lib",
];

/** @returns {NativeBuildEnv | null} */
function resolveWindowsNativeBuildEnv() {
  const sdk = resolveWindowsSdkLayout();
  const msvc = resolveMsvcToolsLayout();
  const envLibPaths = splitPathList(process.env.LIB).filter(
    (item) => !isX86WindowsLibraryPath(item),
  );
  const libPaths = buildLibraryPaths(sdk, msvc, envLibPaths);
  if (!hasRequiredNativeLibraries(libPaths)) return null;
  const includePaths = uniqueExistingDirs([
    ...(sdk ? sdk.includePaths : []),
    ...(msvc ? [msvc.includePath] : []),
    ...splitPathList(process.env.INCLUDE),
  ]);
  const pathEntries = uniqueExistingDirs([
    ...(sdk?.binPath ? [sdk.binPath] : []),
    ...(msvc?.binPath ? [msvc.binPath] : []),
    ...splitPathList(process.env.PATH),
  ]);
  return { sdkVersion: sdk?.version, pathEntries, includePaths, libPaths };
}

/**
 * @param {WindowsSdkLayout | null} sdk
 * @param {MsvcToolsLayout | null} msvc
 * @param {string[]} envLibPaths
 */
function buildLibraryPaths(sdk, msvc, envLibPaths) {
  return uniqueExistingDirs([
    ...(sdk ? [sdk.umLibPath, sdk.ucrtLibPath] : []),
    ...(msvc ? [msvc.libPath] : []),
    ...envLibPaths,
  ]);
}

/** @param {string[]} libPaths */
function hasRequiredNativeLibraries(libPaths) {
  const sdkNames = [
    "kernel32.lib",
    "user32.lib",
    "gdi32.lib",
    "shell32.lib",
    "ole32.lib",
    "uuid.lib",
    "advapi32.lib",
  ];
  const hasSdk = sdkNames.every((file) => pathListContainsFile(libPaths, file));
  const hasMsvc =
    pathListContainsFile(libPaths, "oldnames.lib") &&
    pathListContainsFile(libPaths, "vcruntime.lib") &&
    ["msvcrt.lib", "msvcrtd.lib"].some((file) =>
      pathListContainsFile(libPaths, file),
    );
  return hasSdk && pathListContainsFile(libPaths, "ucrt.lib") && hasMsvc;
}

/** @param {string[]} libPaths @returns {string[]} */
function resolveWindowsRuntimeLibraryPaths(libPaths) {
  return [...windowsDynamicRuntimeLibNames, ...windowsSystemImportLibNames].map(
    (fileName) => resolveRequiredLibrary(libPaths, fileName),
  );
}

/** @param {string[]} libPaths @param {string} fileName */
function resolveRequiredLibrary(libPaths, fileName) {
  const match = findFileInPathList(libPaths, fileName);
  if (!match) {
    throw new Error(
      `Required Windows/MSVC runtime library was not found: ${fileName}`,
    );
  }
  if (isX86WindowsLibraryPath(match)) {
    throw new Error(
      `Resolved a 32-bit Windows/MSVC runtime library while building x64: ${match}`,
    );
  }
  return match;
}

/** @param {string} filePath */
function isX86WindowsLibraryPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    /\/lib\/x86(\/|$)/.test(normalized) ||
    /\/(um|ucrt)\/x86(\/|$)/.test(normalized)
  );
}

function formatWindowsNativeBuildToolsMissingMessage() {
  return [
    "Windows SDK and Microsoft C++ Build Tools were not found.",
    "Install Visual Studio 2022 Build Tools with Desktop development with C++ and a Windows 10/11 SDK.",
    "If they are already installed, run from Developer Command Prompt or set MANGA_TRANSLATOR_WINDOWS_KITS_ROOT / MANGA_TRANSLATOR_MSVC_TOOLS_ROOT.",
  ].join(" ");
}

/** @returns {WindowsSdkLayout | null} */
function resolveWindowsSdkLayout() {
  const roots = uniquePaths([
    process.env.MANGA_TRANSLATOR_WINDOWS_KITS_ROOT,
    process.env.MGT_WINDOWS_KITS_ROOT,
    process.env.WindowsSdkDir,
    process.env.UniversalCRTSdkDir,
    programFilesSubpath("ProgramFiles(x86)", "Windows Kits", "10"),
    programFilesSubpath("ProgramFiles", "Windows Kits", "10"),
  ]);
  for (const root of roots) {
    const layout = findWindowsSdkLayout(root);
    if (layout) return layout;
  }
  return null;
}

/** @param {string} variable @param {...string} segments */
function programFilesSubpath(variable, ...segments) {
  const base = process.env[variable];
  return base ? join(base, ...segments) : "";
}

/** @param {string} root @returns {WindowsSdkLayout | null} */
function findWindowsSdkLayout(root) {
  const libRoot = join(root, "Lib");
  const includeRoot = join(root, "Include");
  const versions = readChildDirectories(libRoot).sort(compareVersionDesc);
  for (const version of versions) {
    const layout = toWindowsSdkLayout(root, includeRoot, libRoot, version);
    if (layout) return layout;
  }
  return null;
}

/**
 * @param {string} root
 * @param {string} includeRoot
 * @param {string} libRoot
 * @param {string} version
 * @returns {WindowsSdkLayout | null}
 */
function toWindowsSdkLayout(root, includeRoot, libRoot, version) {
  const umLibPath = join(libRoot, version, "um", "x64");
  const ucrtLibPath = join(libRoot, version, "ucrt", "x64");
  if (!isFile(join(umLibPath, "kernel32.lib")) || !isDirectory(ucrtLibPath)) {
    return null;
  }
  const includePaths = ["ucrt", "shared", "um", "winrt", "cppwinrt"]
    .map((name) => join(includeRoot, version, name))
    .filter(isDirectory);
  const binPath = join(root, "bin", version, "x64");
  return {
    root,
    version,
    umLibPath,
    ucrtLibPath,
    includePaths,
    binPath: isDirectory(binPath) ? binPath : undefined,
  };
}

/** @returns {MsvcToolsLayout | null} */
function resolveMsvcToolsLayout() {
  const directRoots = uniquePaths([
    process.env.MANGA_TRANSLATOR_MSVC_TOOLS_ROOT,
    process.env.MGT_MSVC_TOOLS_ROOT,
    process.env.VCToolsInstallDir,
  ]);
  for (const root of directRoots) {
    const layout = toMsvcToolsLayout(root);
    if (layout) return layout;
  }
  for (const versionRoot of uniquePaths(resolveMsvcVersionRoots())) {
    const layout = findMsvcVersionLayout(versionRoot);
    if (layout) return layout;
  }
  return null;
}

/** @returns {string[]} */
function resolveMsvcVersionRoots() {
  const roots = process.env.VCINSTALLDIR
    ? [join(process.env.VCINSTALLDIR, "Tools", "MSVC")]
    : [];
  const programFiles = process.env.ProgramFiles;
  if (!programFiles) return roots;
  for (const year of ["2022", "2019"]) {
    for (const edition of [
      "BuildTools",
      "Community",
      "Professional",
      "Enterprise",
    ]) {
      roots.push(
        join(
          programFiles,
          "Microsoft Visual Studio",
          year,
          edition,
          "VC",
          "Tools",
          "MSVC",
        ),
      );
    }
  }
  return roots;
}

/** @param {string} versionRoot @returns {MsvcToolsLayout | null} */
function findMsvcVersionLayout(versionRoot) {
  const versions = readChildDirectories(versionRoot).sort(compareVersionDesc);
  for (const version of versions) {
    const layout = toMsvcToolsLayout(join(versionRoot, version), version);
    if (layout) return layout;
  }
  return null;
}

/**
 * @param {string} root
 * @param {string} [version]
 * @returns {MsvcToolsLayout | null}
 */
function toMsvcToolsLayout(root, version) {
  const libPath = join(root, "lib", "x64");
  const includePath = join(root, "include");
  if (!isFile(join(libPath, "oldnames.lib")) || !isDirectory(includePath)) {
    return null;
  }
  const binPath = join(root, "bin", "Hostx64", "x64");
  return {
    root,
    version,
    libPath,
    includePath,
    binPath: isDirectory(binPath) ? binPath : undefined,
  };
}

/** @param {unknown} value */
function splitPathList(value) {
  return String(value || "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** @param {...unknown} values */
function mergePathList(...values) {
  /** @type {string[]} */
  const entries = [];
  for (const value of values) {
    if (!value) continue;
    entries.push(
      ...(Array.isArray(value) ? value.map(String) : splitPathList(value)),
    );
  }
  return uniquePaths(entries).join(delimiter);
}

/** @param {...unknown} values */
function mergeWords(...values) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

/** @param {Iterable<unknown>} paths */
function uniqueExistingDirs(paths) {
  return uniquePaths(paths).filter(isDirectory);
}

/** @param {Iterable<unknown>} paths */
function uniquePaths(paths) {
  const seen = new Set();
  /** @type {string[]} */
  const result = [];
  for (const rawPath of paths) {
    const value = String(rawPath || "").trim();
    if (!value) continue;
    const normalized = resolve(value);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/** @param {string} root */
function readChildDirectories(root) {
  try {
    return readdirSync(root)
      .map((name) => ({ name, path: join(root, name) }))
      .filter((entry) => isDirectory(entry.path))
      .map((entry) => entry.name);
  } catch (error) {
    void error;
    return [];
  }
}

/** @param {string} left @param {string} right */
function compareVersionDesc(left, right) {
  return compareVersionStrings(right, left);
}

/** @param {string} left @param {string} right */
function compareVersionStrings(left, right) {
  const leftParts = toVersionParts(left);
  const rightParts = toVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }
  return left.localeCompare(right);
}

/** @param {string} value */
function toVersionParts(value) {
  return value
    .split(/[^\d]+/)
    .filter(Boolean)
    .map(Number);
}

/** @param {string[]} paths @param {string} fileName */
function pathListContainsFile(paths, fileName) {
  return paths.some((dir) => isFile(join(dir, fileName)));
}

/** @param {string[]} paths @param {string} fileName */
function findFileInPathList(paths, fileName) {
  for (const dir of paths) {
    const candidate = join(dir, fileName);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

module.exports = {
  findFileInPathList,
  formatWindowsNativeBuildToolsMissingMessage,
  isDirectory,
  isFile,
  isPathInside,
  mergePathList,
  mergeWords,
  resolveWindowsNativeBuildEnv,
  resolveWindowsRuntimeLibraryPaths,
  splitPathList,
  toCmakePath,
  uniqueExistingDirs,
  uniquePaths,
};
