import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AppPaths } from "./appPaths";

export const BUNDLED_CODEX_VERSION = "0.153.1";

type SupportedCodexTarget = {
  packageName: string;
  triple: string;
  executableName: string;
};

const CODEX_TARGETS: Record<string, SupportedCodexTarget> = {
  "win32/x64": {
    packageName: "@openai/codex-win32-x64",
    triple: "x86_64-pc-windows-msvc",
    executableName: "codex.exe",
  },
  "win32/arm64": {
    packageName: "@openai/codex-win32-arm64",
    triple: "aarch64-pc-windows-msvc",
    executableName: "codex.exe",
  },
  "darwin/x64": {
    packageName: "@openai/codex-darwin-x64",
    triple: "x86_64-apple-darwin",
    executableName: "codex",
  },
  "darwin/arm64": {
    packageName: "@openai/codex-darwin-arm64",
    triple: "aarch64-apple-darwin",
    executableName: "codex",
  },
  "linux/x64": {
    packageName: "@openai/codex-linux-x64",
    triple: "x86_64-unknown-linux-musl",
    executableName: "codex",
  },
  "linux/arm64": {
    packageName: "@openai/codex-linux-arm64",
    triple: "aarch64-unknown-linux-musl",
    executableName: "codex",
  },
};

const requireFromHere = createRequire(__filename);

export type CodexAppServerBinary = SupportedCodexTarget & {
  executablePath: string;
  packageVersion: string;
  source: "packaged" | "node_modules";
};

export function resolveCodexAppServerBinary(
  paths: Pick<AppPaths, "isPackaged" | "resourcesDir">,
  platform = process.platform,
  arch = process.arch,
): CodexAppServerBinary {
  const target = CODEX_TARGETS[`${platform}/${arch}`];
  if (!target) {
    throw new Error(
      `내장 Codex App Server가 이 플랫폼을 지원하지 않습니다: ${platform}/${arch}`,
    );
  }

  const packagedPath = join(
    paths.resourcesDir,
    "c",
    "bin",
    target.executableName,
  );
  if (paths.isPackaged && existsSync(packagedPath)) {
    return {
      ...target,
      executablePath: packagedPath,
      packageVersion: readPackagedCodexVersion(paths.resourcesDir),
      source: "packaged",
    };
  }

  const packageJsonPath = resolvePlatformPackageJson(target.packageName);
  if (packageJsonPath) {
    const packageRoot = dirname(packageJsonPath);
    const executablePath = join(
      packageRoot,
      "vendor",
      target.triple,
      "bin",
      target.executableName,
    );
    if (existsSync(executablePath)) {
      return {
        ...target,
        executablePath,
        packageVersion: readPackageVersion(packageJsonPath, platform, arch),
        source: "node_modules",
      };
    }
  }

  throw new Error(
    `공식 Codex App Server 실행 파일을 찾지 못했습니다. 앱을 다시 설치해 주세요. (${target.packageName})`,
  );
}

function resolvePlatformPackageJson(packageName: string): string | null {
  try {
    return requireFromHere.resolve(`${packageName}/package.json`);
  } catch (_error) {
    return null;
  }
}

function readPackagedCodexVersion(resourcesDir: string): string {
  const manifestPath = join(resourcesDir, "c", "codex-package.json");
  const version = readJsonStringField(manifestPath, "version");
  if (version !== BUNDLED_CODEX_VERSION) {
    throw new Error(
      `내장 Codex 버전이 일치하지 않습니다: ${version || "unknown"}`,
    );
  }
  return version;
}

function readPackageVersion(
  packageJsonPath: string,
  platform: string,
  arch: string,
): string {
  const version = readJsonStringField(packageJsonPath, "version");
  if (
    version !==
    `${BUNDLED_CODEX_VERSION}-${platformPackageSuffix(platform, arch)}`
  ) {
    throw new Error(
      `설치된 Codex 플랫폼 패키지 버전이 일치하지 않습니다: ${version || "unknown"}`,
    );
  }
  return BUNDLED_CODEX_VERSION;
}

function platformPackageSuffix(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

function readJsonStringField(filePath: string, field: string): string {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)[field] === "string"
    ) {
      return (parsed as Record<string, string>)[field];
    }
  } catch (_error) {
    // error-policy-allow: the caller reports one bounded installation error without leaking paths.
    // The caller reports one bounded installation error without leaking paths.
  }
  return "";
}
