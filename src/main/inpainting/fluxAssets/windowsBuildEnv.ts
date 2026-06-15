import { copyFileSync, mkdirSync } from "node:fs";
import { basename, delimiter, join, resolve } from "node:path";
import {
  WINDOWS_DYNAMIC_RUNTIME_LIB_NAMES,
  WINDOWS_SYSTEM_IMPORT_LIB_NAMES,
} from "./constants";
import type { WindowsNativeBuildEnv } from "./types";
import {
  compareVersionDesc,
  directoryExists,
  fileExists,
  findFileInPathList,
  pathListContainsFile,
  readChildDirectories,
  uniqueExistingDirs,
  uniquePaths,
} from "./fileProbe";

export function resolveWindowsNativeBuildEnv(): WindowsNativeBuildEnv | null {
  if (process.platform !== "win32") {
    return null;
  }
  const sdk = resolveWindowsSdkLayout();
  const msvc = resolveMsvcToolsLayout();
  const envLibPaths = splitPathList(process.env.LIB).filter(
    (item) => !isX86WindowsLibraryPath(item),
  );
  const envIncludePaths = splitPathList(process.env.INCLUDE);
  const envPathEntries = splitPathList(process.env.PATH);
  const libPaths = uniqueExistingDirs([
    ...(sdk ? [sdk.umLibPath, sdk.ucrtLibPath] : []),
    ...(msvc ? [msvc.libPath] : []),
    ...envLibPaths,
  ]);
  const includePaths = uniqueExistingDirs([
    ...(sdk ? sdk.includePaths : []),
    ...(msvc ? [msvc.includePath] : []),
    ...envIncludePaths,
  ]);
  const pathEntries = uniqueExistingDirs([
    ...(sdk?.binPath ? [sdk.binPath] : []),
    ...(msvc?.binPath ? [msvc.binPath] : []),
    ...envPathEntries,
  ]);
  const hasWindowsSdkLibs = [
    "kernel32.lib",
    "user32.lib",
    "gdi32.lib",
    "shell32.lib",
    "ole32.lib",
    "uuid.lib",
    "advapi32.lib",
  ].every((file) => pathListContainsFile(libPaths, file));
  const hasUcrtLibs = pathListContainsFile(libPaths, "ucrt.lib");
  const hasMsvcLibs =
    pathListContainsFile(libPaths, "oldnames.lib") &&
    pathListContainsFile(libPaths, "vcruntime.lib") &&
    (pathListContainsFile(libPaths, "msvcrt.lib") ||
      pathListContainsFile(libPaths, "msvcrtd.lib"));
  if (!hasWindowsSdkLibs || !hasUcrtLibs || !hasMsvcLibs) {
    return null;
  }
  return {
    sdkVersion: sdk?.version,
    pathEntries,
    includePaths,
    libPaths,
  };
}

export function resolveWindowsRuntimeLibraryPaths(
  libPaths: string[],
): string[] {
  return [
    ...WINDOWS_DYNAMIC_RUNTIME_LIB_NAMES,
    ...WINDOWS_SYSTEM_IMPORT_LIB_NAMES,
  ].map((fileName) => {
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
  });
}

function isX86WindowsLibraryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    /\/lib\/x86(\/|$)/.test(normalized) ||
    /\/(um|ucrt)\/x86(\/|$)/.test(normalized)
  );
}

export function formatWindowsNativeBuildToolsMissingMessage(): string {
  return [
    "Flux ROCm 런타임을 빌드하려면 Windows SDK와 Microsoft C++ Build Tools가 필요합니다.",
    "현재 Windows import library(kernel32.lib 등) 또는 MSVC library(oldnames.lib/msvcrt.lib)를 찾지 못했습니다.",
    'Visual Studio 2022 Build Tools에서 "Desktop development with C++"와 Windows 10/11 SDK를 설치한 뒤 다시 시도하세요.',
    "이미 설치되어 있다면 Developer Command Prompt에서 실행하거나 MANGA_TRANSLATOR_WINDOWS_KITS_ROOT / MANGA_TRANSLATOR_MSVC_TOOLS_ROOT 환경변수로 위치를 지정할 수 있습니다.",
  ].join(" ");
}

function resolveWindowsSdkLayout(): {
  root: string;
  version: string;
  umLibPath: string;
  ucrtLibPath: string;
  includePaths: string[];
  binPath?: string;
} | null {
  const roots = uniquePaths([
    process.env.MANGA_TRANSLATOR_WINDOWS_KITS_ROOT,
    process.env.MGT_WINDOWS_KITS_ROOT,
    process.env.WindowsSdkDir,
    process.env.UniversalCRTSdkDir,
    process.env["ProgramFiles(x86)"]
      ? join(process.env["ProgramFiles(x86)"] as string, "Windows Kits", "10")
      : "",
    process.env.ProgramFiles
      ? join(process.env.ProgramFiles, "Windows Kits", "10")
      : "",
  ]);
  for (const root of roots) {
    const libRoot = join(root, "Lib");
    const includeRoot = join(root, "Include");
    const versions = readChildDirectories(libRoot).sort(compareVersionDesc);
    for (const version of versions) {
      const umLibPath = join(libRoot, version, "um", "x64");
      const ucrtLibPath = join(libRoot, version, "ucrt", "x64");
      if (
        !fileExists(join(umLibPath, "kernel32.lib")) ||
        !directoryExists(ucrtLibPath)
      ) {
        continue;
      }
      const includePaths = ["ucrt", "shared", "um", "winrt", "cppwinrt"]
        .map((name) => join(includeRoot, version, name))
        .filter(directoryExists);
      const binPath = join(root, "bin", version, "x64");
      return {
        root,
        version,
        umLibPath,
        ucrtLibPath,
        includePaths,
        binPath: directoryExists(binPath) ? binPath : undefined,
      };
    }
  }
  return null;
}

function resolveMsvcToolsLayout(): {
  root: string;
  version?: string;
  libPath: string;
  includePath: string;
  binPath?: string;
} | null {
  const directRoots = uniquePaths([
    process.env.MANGA_TRANSLATOR_MSVC_TOOLS_ROOT,
    process.env.MGT_MSVC_TOOLS_ROOT,
    process.env.VCToolsInstallDir,
  ]);
  for (const root of directRoots) {
    const layout = toMsvcToolsLayout(root);
    if (layout) {
      return layout;
    }
  }

  const versionRoots: string[] = [];
  if (process.env.VCINSTALLDIR) {
    versionRoots.push(join(process.env.VCINSTALLDIR, "Tools", "MSVC"));
  }
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    for (const year of ["2022", "2019"]) {
      for (const edition of [
        "BuildTools",
        "Community",
        "Professional",
        "Enterprise",
      ]) {
        versionRoots.push(
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
  }
  for (const versionRoot of uniquePaths(versionRoots)) {
    const versions = readChildDirectories(versionRoot).sort(compareVersionDesc);
    for (const version of versions) {
      const layout = toMsvcToolsLayout(join(versionRoot, version), version);
      if (layout) {
        return layout;
      }
    }
  }
  return null;
}

function toMsvcToolsLayout(
  root: string,
  version?: string,
): {
  root: string;
  version?: string;
  libPath: string;
  includePath: string;
  binPath?: string;
} | null {
  const libPath = join(root, "lib", "x64");
  const includePath = join(root, "include");
  if (
    !fileExists(join(libPath, "oldnames.lib")) ||
    !directoryExists(includePath)
  ) {
    return null;
  }
  const binPath = join(root, "bin", "Hostx64", "x64");
  return {
    root,
    version,
    libPath,
    includePath,
    binPath: directoryExists(binPath) ? binPath : undefined,
  };
}

function splitPathList(value?: string): string[] {
  return (value ?? "")
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function mergePathList(
  ...values: Array<string | string[] | null | undefined>
): string {
  const entries: string[] = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      entries.push(...value);
    } else {
      entries.push(...splitPathList(value));
    }
  }
  return uniquePaths(entries).join(delimiter);
}

export function mergeWords(
  ...values: Array<string | string[] | null | undefined>
): string {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

export function quoteCmakeArg(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function quoteShellToken(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

export function toCmakePath(pathValue: string): string {
  return resolve(pathValue).replace(/\\/g, "/");
}

export function stageWindowsResourceCompiler(
  runtimeDir: string,
  rcCompiler: string | null,
): string | null {
  if (!rcCompiler) {
    return rcCompiler;
  }
  const stagedDir = join(runtimeDir, "native-tools");
  const stagedPath = join(stagedDir, "rc.exe");
  mkdirSync(stagedDir, { recursive: true });
  copyFileSync(rcCompiler, stagedPath);
  return stagedPath;
}

export function stageWindowsRuntimeLibraries(
  runtimeDir: string,
  libraryPaths: string[],
): string[] {
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

export function resolveWindowsResourceCompiler(
  rocmPaths: { llvmRc: string },
  nativeBuildEnv: WindowsNativeBuildEnv | null,
): string | null {
  if (fileExists(rocmPaths.llvmRc)) {
    return rocmPaths.llvmRc;
  }
  return nativeBuildEnv
    ? findFileInPathList(nativeBuildEnv.pathEntries, "rc.exe")
    : null;
}
