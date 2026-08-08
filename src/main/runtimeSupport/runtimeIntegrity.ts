import manifest from "../runtime/runtime-integrity-manifest.json";

export const RUNTIME_INTEGRITY_MANIFEST = manifest;

function normalizeMandatorySha256(value: unknown): string {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

/**
 * Built-in URLs inherit the hash shipped with the application. Any URL
 * override must carry its own explicit digest and therefore cannot silently
 * downgrade integrity enforcement.
 */
export function resolvePinnedRemoteAsset(options: {
  defaultUrl: string;
  defaultSha256: string;
  url: string;
  overrideSha256?: unknown;
  label: string;
}): { url: string; sha256: string } {
  const url = String(options.url || "").trim();
  const defaultSha256 = normalizeMandatorySha256(options.defaultSha256);
  const overrideSha256 = normalizeMandatorySha256(options.overrideSha256);
  const sha256 =
    url === options.defaultUrl
      ? overrideSha256 || defaultSha256
      : overrideSha256;
  if (!url || !sha256) {
    throw new Error(`${options.label} requires a pinned SHA-256 digest.`);
  }
  return { url, sha256 };
}
