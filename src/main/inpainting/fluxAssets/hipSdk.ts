import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, normalize } from "node:path";

const SUPPORTED_HIP_RUNTIME_DLLS = [
  "amdhip64_7.dll",
  "amdhip64_6.dll",
] as const;

type HipSdkCandidateSource = "HIP_PATH" | "ROCM_PATH" | "PATH" | "standard";

type HipSdkCandidate = {
  binDir: string;
  rootDir: string;
  source: HipSdkCandidateSource;
};

type HipSdkCandidateCollector = {
  add: (rootDir: string, binDir: string, source: HipSdkCandidateSource) => void;
  candidates: HipSdkCandidate[];
};

type WindowsHipSdk = {
  binDir: string;
  rootDir: string;
  runtimeDllPath: string;
  source: HipSdkCandidateSource;
  version: string | null;
};

export type WindowsHipSdkProbe = {
  incompatibleRuntimeDlls: string[];
  platformSupported: boolean;
  searchedBinDirs: string[];
  sdk: WindowsHipSdk | null;
};

export type DiscoverWindowsHipSdkOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Tests can replace the machine-wide roots without probing the real PC. */
  standardRoots?: string[];
};

/**
 * Finds a usable Windows HIP SDK without pinning the app to a ROCm minor
 * version. Explicit environment variables win, followed by PATH and then the
 * newest version installed under AMD's standard Program Files directory.
 */
export async function discoverWindowsHipSdk(
  options: DiscoverWindowsHipSdkOptions = {},
): Promise<WindowsHipSdkProbe> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return createUnsupportedPlatformProbe();
  const candidates = await collectWindowsHipSdkCandidates(
    env,
    options.standardRoots ?? resolveStandardHipSdkRoots(env),
  );
  return probeHipSdkCandidates(candidates);
}

function createUnsupportedPlatformProbe(): WindowsHipSdkProbe {
  return {
    incompatibleRuntimeDlls: [],
    platformSupported: false,
    searchedBinDirs: [],
    sdk: null,
  };
}

async function collectWindowsHipSdkCandidates(
  env: NodeJS.ProcessEnv,
  standardRoots: string[],
): Promise<HipSdkCandidate[]> {
  const collector = createHipSdkCandidateCollector();
  await addCandidatePath(collector, env.HIP_PATH, "HIP_PATH");
  await addCandidatePath(collector, env.ROCM_PATH, "ROCM_PATH");
  for (const entry of String(env.PATH ?? "").split(";")) {
    await addCandidatePath(collector, entry, "PATH");
  }
  for (const root of standardRoots) {
    await addStandardRootCandidates(collector, root);
  }
  return collector.candidates;
}

function createHipSdkCandidateCollector(): HipSdkCandidateCollector {
  const candidates: HipSdkCandidate[] = [];
  const seenCandidates = new Set<string>();
  return {
    candidates,
    add(rootDir, binDir, source) {
      const normalizedRoot = normalizeCandidatePath(rootDir);
      const normalizedBin = normalizeCandidatePath(binDir);
      if (!normalizedRoot || !normalizedBin) return;
      const key = normalizedBin.toLowerCase();
      if (seenCandidates.has(key)) return;
      seenCandidates.add(key);
      candidates.push({
        rootDir: normalizedRoot,
        binDir: normalizedBin,
        source,
      });
    },
  };
}

async function addCandidatePath(
  collector: HipSdkCandidateCollector,
  rawPath: string | undefined,
  source: HipSdkCandidateSource,
): Promise<void> {
  const candidatePath = normalizeCandidatePath(rawPath);
  if (!candidatePath) return;
  if (basename(candidatePath).toLowerCase() === "bin") {
    collector.add(dirname(candidatePath), candidatePath, source);
    return;
  }
  collector.add(candidatePath, join(candidatePath, "bin"), source);
  for (const versionDir of await listVersionDirectories(candidatePath)) {
    collector.add(versionDir, join(versionDir, "bin"), source);
  }
  // PATH can point directly at a custom runtime directory whose name is not
  // literally "bin". This harmless fallback also supports such layouts.
  collector.add(dirname(candidatePath), candidatePath, source);
}

async function addStandardRootCandidates(
  collector: HipSdkCandidateCollector,
  root: string,
): Promise<void> {
  for (const versionDir of await listVersionDirectories(root)) {
    collector.add(versionDir, join(versionDir, "bin"), "standard");
  }
  collector.add(root, join(root, "bin"), "standard");
}

async function probeHipSdkCandidates(
  candidates: HipSdkCandidate[],
): Promise<WindowsHipSdkProbe> {
  const searchedBinDirs: string[] = [];
  const incompatibleRuntimeDlls: string[] = [];
  for (const candidate of candidates) {
    searchedBinDirs.push(candidate.binDir);
    for (const runtimeDll of SUPPORTED_HIP_RUNTIME_DLLS) {
      const runtimeDllPath = join(candidate.binDir, runtimeDll);
      if (existsSync(runtimeDllPath)) {
        return {
          incompatibleRuntimeDlls,
          platformSupported: true,
          searchedBinDirs,
          sdk: {
            ...candidate,
            runtimeDllPath,
            version: resolveHipSdkVersion(candidate.rootDir, runtimeDll),
          },
        };
      }
    }
    incompatibleRuntimeDlls.push(
      ...(await listIncompatibleHipRuntimeDlls(candidate.binDir)),
    );
  }

  return {
    incompatibleRuntimeDlls: uniqueCaseInsensitive(incompatibleRuntimeDlls),
    platformSupported: true,
    searchedBinDirs,
    sdk: null,
  };
}

export function formatWindowsHipSdkProbeError(
  probe: WindowsHipSdkProbe,
): Error {
  if (!probe.platformSupported) {
    return new Error(
      "Flux ZLUDA는 Windows용 AMD HIP SDK가 필요한 백엔드입니다. 이 운영체제에서는 CPU 백엔드를 사용해 주세요.",
    );
  }
  const shown = probe.searchedBinDirs.slice(0, 12);
  const remaining = probe.searchedBinDirs.length - shown.length;
  const searched = shown.length
    ? `${shown.join("\n- ")}${remaining > 0 ? `\n- 외 ${remaining}곳` : ""}`
    : "(검색할 수 있는 설치 경로가 없었습니다.)";
  const incompatible = probe.incompatibleRuntimeDlls.length
    ? `\n호환되지 않는 HIP DLL도 발견했습니다: ${probe.incompatibleRuntimeDlls.join(", ")}`
    : "";
  return new Error(
    [
      "AMD HIP SDK 런타임을 찾지 못해 Flux ZLUDA를 시작할 수 없습니다.",
      `필요한 파일: ${SUPPORTED_HIP_RUNTIME_DLLS.join(" 또는 ")}`,
      `확인한 위치:\n- ${searched}`,
      incompatible,
      "HIP SDK를 설치한 뒤 앱을 다시 시작하거나, 설정에서 Flux 백엔드를 CPU로 바꿔 주세요.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function resolveStandardHipSdkRoots(env: NodeJS.ProcessEnv): string[] {
  const systemDrive = normalizeCandidatePath(env.SystemDrive) ?? "C:";
  const roots = [join(systemDrive, "hip_sdk")];
  for (const programFiles of [
    env.ProgramW6432,
    env.ProgramFiles,
    join(systemDrive, "Program Files"),
  ]) {
    const normalized = normalizeCandidatePath(programFiles);
    if (normalized) roots.push(join(normalized, "AMD", "ROCm"));
  }
  return uniqueCaseInsensitive(roots);
}

async function listVersionDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^\d+(?:\.\d+){0,3}(?:[-_].*)?$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort(compareVersionNamesDescending)
      .map((name) => join(root, name));
  } catch (error) {
    if (isOptionalDirectoryReadError(error)) return [];
    throw error;
  }
}

async function listIncompatibleHipRuntimeDlls(
  binDir: string,
): Promise<string[]> {
  try {
    const entries = await readdir(binDir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /^amdhip64.*\.dll$/i.test(entry.name) &&
          !SUPPORTED_HIP_RUNTIME_DLLS.some(
            (supported) => supported.toLowerCase() === entry.name.toLowerCase(),
          ),
      )
      .map((entry) => join(binDir, entry.name));
  } catch (error) {
    if (isOptionalDirectoryReadError(error)) return [];
    throw error;
  }
}

function isOptionalDirectoryReadError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(error.code));
}

function compareVersionNamesDescending(left: string, right: string): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return right.localeCompare(left);
}

function parseVersionParts(value: string): number[] {
  return value
    .split(/[._-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);
}

function resolveHipSdkVersion(
  rootDir: string,
  runtimeDll: string,
): string | null {
  const rootName = basename(rootDir);
  if (/^\d+(?:\.\d+){0,3}(?:[-_].*)?$/.test(rootName)) return rootName;
  const match = runtimeDll.match(/_(\d+)\.dll$/i);
  return match?.[1] ?? null;
}

function normalizeCandidatePath(value: string | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const unquoted = trimmed.replace(/^"(.*)"$/, "$1").trim();
  return unquoted ? normalize(unquoted) : null;
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
