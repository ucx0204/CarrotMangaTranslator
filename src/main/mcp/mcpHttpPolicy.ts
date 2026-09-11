import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { McpConfiguration } from "./mcpConfiguration";
import { MCP_PROTOCOL_VERSIONS } from "./mcpProtocol";

export class McpHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function authorizeMcpRequest(
  request: IncomingMessage,
  config: McpConfiguration,
): void {
  const localOrigin = `http://127.0.0.1:${config.port}`;
  const origins = [localOrigin, `http://localhost:${config.port}`];
  if (config.publicOrigin) origins.push(config.publicOrigin);
  const host = singleHeader(request, "host", true);
  if (!origins.some((origin) => new URL(origin).host === host))
    throw new McpHttpError(403, "Host is not allowed.");
  const origin = singleHeader(request, "origin", false);
  if (origin !== undefined && !origins.includes(origin))
    throw new McpHttpError(403, "Origin is not allowed.");
  const authorization = singleHeader(request, "authorization", false) ?? "";
  const actual = createHash("sha256").update(authorization).digest();
  const expected = createHash("sha256")
    .update(`Bearer ${config.token}`)
    .digest();
  if (!timingSafeEqual(actual, expected))
    throw new McpHttpError(401, "Authentication required.");
}

export function validateMcpPost(request: IncomingMessage): void {
  const version = singleHeader(request, "mcp-protocol-version", false);
  if (
    version !== undefined &&
    !MCP_PROTOCOL_VERSIONS.some((item) => item === version)
  )
    throw new McpHttpError(400, "Unsupported MCP protocol version.");
  const accept = request.headers.accept ?? "";
  if (
    !accepts(accept, "application/json") ||
    !accepts(accept, "text/event-stream")
  )
    throw new McpHttpError(
      406,
      "Accept must include application/json and text/event-stream.",
    );
  const contentType = singleHeader(
    request,
    "content-type",
    true,
  )?.toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType ?? ""))
    throw new McpHttpError(415, "A UTF-8 application/json body is required.");
  if (request.headers["content-encoding"] !== undefined)
    throw new McpHttpError(415, "Content encoding is not supported.");
}

function singleHeader(
  request: IncomingMessage,
  name: string,
  required: boolean,
) {
  const values = request.headersDistinct[name];
  if ((!values && required) || (values && values.length !== 1))
    throw new McpHttpError(400, "Invalid HTTP headers.");
  return values?.[0];
}

function accepts(value: string, mimeType: string): boolean {
  return value.split(",").some((part) => {
    const [type, ...parameters] = part.trim().toLowerCase().split(";");
    if (type.trim() !== mimeType) return false;
    const quality = parameters.find((parameter) =>
      parameter.trim().startsWith("q="),
    );
    return quality === undefined || Number(quality.trim().slice(2)) > 0;
  });
}
