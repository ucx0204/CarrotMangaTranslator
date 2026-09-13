import { createHash, timingSafeEqual } from "node:crypto";

export class McpOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function oauthRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new McpOAuthError("invalid_request", "An object is required.");
  return value as Record<string, unknown>;
}
export function oauthText(value: unknown, max = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new McpOAuthError("invalid_request", "A required field is invalid.");
  return value;
}
export function oauthDigest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
export function oauthEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    Buffer.from(oauthDigest(left)),
    Buffer.from(oauthDigest(right)),
  );
}
/** DCR is restricted to documented ChatGPT callback shapes. Each registration
 * stores exact URIs, and authorization must match one of those exact strings.
 * Never fetch a caller-supplied client_uri, logo_uri or metadata URL. */
export function readChatGptRedirect(value: unknown): string {
  const text = oauthText(value);
  let url: URL;
  try {
    url = new URL(text);
  } catch (_error) {
    throw new McpOAuthError("invalid_redirect_uri", "Invalid callback URL.");
  }
  const pathAllowed =
    /^\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname) ||
    url.pathname === "/connector_platform_oauth_redirect";
  if (
    url.origin !== "https://chatgpt.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !pathAllowed ||
    url.href !== text
  )
    throw new McpOAuthError(
      "invalid_redirect_uri",
      "Only exact ChatGPT callback URLs are supported by this test server.",
    );
  return text;
}
export function readOAuthScope(
  value: unknown,
  allowEdits = false,
  allowImages = false,
  allowProcessing = false,
): string {
  const scope = value === undefined ? "carrot.read" : oauthText(value, 200);
  const scopes = [...new Set(scope.split(" ").filter(Boolean))];
  if (
    !scopes.includes("carrot.read") ||
    scopes.some(
      (item) =>
        ![
          "carrot.read",
          ...(allowImages ? ["carrot.images"] : []),
          ...(allowEdits ? ["carrot.edit"] : []),
          ...(allowProcessing ? ["carrot.process"] : []),
          "offline_access",
        ].includes(item),
    )
  )
    throw new McpOAuthError(
      "invalid_scope",
      "Unsupported MCP permission. carrot.read is required.",
    );
  return scopes.join(" ");
}
export function assertOAuthResource(value: unknown, resource: string): void {
  if (value !== resource)
    throw new McpOAuthError(
      "invalid_target",
      "Use the exact resource from protected-resource metadata.",
    );
}
export function readPkceChallenge(value: unknown, method: unknown): string {
  const challenge = oauthText(value, 43);
  if (method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
    throw new McpOAuthError("invalid_request", "PKCE S256 is required.");
  return challenge;
}
export function verifyPkce(value: unknown, challenge: string): boolean {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._~-]{43,128}$/.test(value) &&
    oauthEqual(oauthDigest(value), challenge)
  );
}
export function uniqueOAuthParams(
  params: URLSearchParams,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key))
      throw new McpOAuthError(
        "invalid_request",
        "Duplicate parameters are not accepted.",
      );
    result[key] = value;
  }
  return result;
}
