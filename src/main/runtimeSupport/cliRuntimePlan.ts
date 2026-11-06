export type ManagedCli = "claude" | "codex" | "grok";

// Official npm tarballs, verified against registry SHA-512 integrity before
// pinning these SHA-256 digests. Never resolve a moving latest tag at runtime.
const assets = {
  "grok/win32-x64": {
    url: "https://registry.npmjs.org/@xai-official/grok-win32-x64/-/grok-win32-x64-1.0.77.tgz",
    bytes: 52329694,
    sha256: "45c694692eaee9c0a79db5555cb534ebfe51375e953c38dc9f9d5a1b2340dad2",
    version: "1.0.77",
    executable: "bin/grok.exe",
    compressedExecutable: "bin/grok.exe.br",
  },
  "grok/darwin-arm64": {
    url: "https://registry.npmjs.org/@xai-official/grok-darwin-arm64/-/grok-darwin-arm64-1.0.77.tgz",
    bytes: 51528196,
    sha256: "d8e9077c2772fcbc1c7530f028e4b797776f951679acc275ef0eed30a8c23d65",
    version: "1.0.77",
    executable: "bin/grok",
    compressedExecutable: "bin/grok.br",
  },
  "claude/win32-x64": {
    url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-0.3.318.tgz",
    bytes: 159306527,
    sha256: "1ab6cf2967d147c748d8bb4b50257f475a4e346f9394db76eef919faa8c9af80",
    version: "0.3.318",
    executable: "claude.exe",
  },
  "claude/darwin-arm64": {
    url: "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-arm64/-/claude-agent-sdk-darwin-arm64-0.3.318.tgz",
    bytes: 145803517,
    sha256: "81392f0170b3b47ce1b84e52d1ac516b630174c07814ea101be0c799c1a46c25",
    version: "0.3.318",
    executable: "claude",
  },
  "codex/win32-x64": {
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.167.0-win32-x64.tgz",
    bytes: 181015521,
    sha256: "075304c882f6618eb73037bdd1164f942516f214108540bdbb9130eff4ab1e08",
    version: "0.167.0-win32-x64",
    executable: "vendor/x86_64-pc-windows-msvc/bin/codex.exe",
  },
  "codex/darwin-arm64": {
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.167.0-darwin-arm64.tgz",
    bytes: 148361216,
    sha256: "6989512a93d5fc74cb221dd348c972bf3cd83592e471bfd9557bccb45eb6fffc",
    version: "0.167.0-darwin-arm64",
    executable: "vendor/aarch64-apple-darwin/bin/codex",
  },
} as const;

export function cliRuntimePlan(
  provider: ManagedCli,
  platform: string = process.platform,
  arch: string = process.arch,
) {
  const key = `${provider}/${platform}-${arch}`;
  const asset = assets[key as keyof typeof assets];
  if (!asset)
    throw new Error(`CLI 자동 설치를 지원하지 않는 플랫폼입니다: ${key}`);
  return {
    ...asset,
    provider,
    target: `${platform}-${arch}`,
    compressedExecutable:
      "compressedExecutable" in asset ? asset.compressedExecutable : undefined,
  };
}
