import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildChannel } from "../shared/runtimeCapabilities";

function normalizeBuildChannel(value: unknown): BuildChannel | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized === "stable" || normalized === "mac-alpha"
    ? normalized
    : undefined;
}

export function readBakedBuildChannel(
  packageJsonPath: string = join(__dirname, "..", "..", "package.json"),
): BuildChannel | undefined {
  try {
    const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      buildChannel?: unknown;
    };
    return normalizeBuildChannel(metadata.buildChannel);
  } catch (error) {
    void error;
    return undefined;
  }
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
