import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildChannel } from "../shared/runtimeCapabilities";

function normalizeBuildChannel(value: unknown): BuildChannel | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized === "stable" || normalized === "mac-alpha"
    ? normalized
    : undefined;
}

function readBakedBuildMetadata(
  packageJsonPath: string = join(__dirname, "..", "..", "package.json"),
): Record<string, unknown> {
  try {
    const metadata: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  } catch (error) {
    void error;
    return {};
  }
}

export function readBakedBuildChannel(
  packageJsonPath?: string,
): BuildChannel | undefined {
  return normalizeBuildChannel(
    readBakedBuildMetadata(packageJsonPath).buildChannel,
  );
}

export function readBakedBuildIdentity(packageJsonPath?: string): {
  buildCommit: string | null;
  buildDirty: boolean | null;
} {
  const metadata = readBakedBuildMetadata(packageJsonPath);
  const buildCommit =
    typeof metadata.buildCommit === "string" &&
    /^[a-f0-9]{40}$/u.test(metadata.buildCommit)
      ? metadata.buildCommit
      : null;
  return {
    buildCommit,
    buildDirty:
      buildCommit && typeof metadata.buildDirty === "boolean"
        ? metadata.buildDirty
        : null,
  };
}

export function resolveBuildChannel(
  platform: string = process.platform,
  arch: string = process.arch,
  explicit: string | undefined = process.env.MANGA_TRANSLATOR_BUILD_CHANNEL,
  baked: BuildChannel | undefined = readBakedBuildChannel(),
): BuildChannel {
  const explicitChannel = normalizeBuildChannel(explicit);
  if (explicitChannel) return explicitChannel;
  if (baked) return baked;
  return platform === "darwin" && arch === "arm64" ? "mac-alpha" : "stable";
}

export function isAppleSiliconAlpha(
  platform: string = process.platform,
  arch: string = process.arch,
  channel: BuildChannel = resolveBuildChannel(platform, arch),
): boolean {
  return platform === "darwin" && arch === "arm64" && channel === "mac-alpha";
}
