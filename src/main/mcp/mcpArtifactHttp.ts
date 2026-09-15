import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpArtifactStore } from "./mcpArtifactStore";
import { McpHttpError } from "./mcpHttpPolicy";

/** Called only after the shared Host/Origin, stopping and concurrency checks.
 * Never accepts a pathname; the unguessable identifier resolves one owned output. */
export async function handleMcpArtifact(
  store: McpArtifactStore | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (!store || !request.url?.startsWith("/mcp-artifacts/")) return false;
  const match = /^\/mcp-artifacts\/([A-Za-z0-9_-]{43})\/page\.png$/.exec(
    request.url,
  );
  if (!match) throw new McpHttpError(404, "Output not found.");
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new McpHttpError(405, "Only GET and HEAD are allowed for outputs.");
  // Do not expose whether denial came from expiry, revision, permission or redaction.
  let bytes: Buffer;
  try {
    bytes = await store.read(match[1]);
  } catch (_error) {
    throw new McpHttpError(
      404,
      "Output is unavailable. Export it again from the app.",
    );
  }
  if (response.destroyed || response.writableEnded) return true;
  response.statusCode = 200;
  response.setHeader("Content-Type", "image/png");
  response.setHeader("Content-Length", bytes.length);
  response.setHeader(
    "Content-Disposition",
    'attachment; filename="carrot-page.png"',
  );
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(request.method === "HEAD" ? undefined : bytes);
  return true;
}
