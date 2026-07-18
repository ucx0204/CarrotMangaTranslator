import type { BuildChannel } from "../shared/runtimeCapabilities";

export function resolveBuildChannel(
  platform: string = process.platform,
  arch: string = process.arch,
  explicit: string | undefined = process.env.MANGA_TRANSLATOR_BUILD_CHANNEL,
): BuildChannel {
  if (explicit?.trim() === "mac-alpha") {
    return "mac-alpha";
  }
  if (explicit?.trim() === "stable") {
    return "stable";
  }
  return platform === "darwin" && arch === "arm64" ? "mac-alpha" : "stable";
}

export function isAppleSiliconAlpha(
  platform: string = process.platform,
  arch: string = process.arch,
  channel: BuildChannel = resolveBuildChannel(platform, arch),
): boolean {
  return platform === "darwin" && arch === "arm64" && channel === "mac-alpha";
}
