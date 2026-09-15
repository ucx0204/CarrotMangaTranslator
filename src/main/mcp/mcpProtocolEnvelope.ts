export const MCP_MODERN_VERSION = "2026-07-28";
export const MCP_SERVER_INFO = {
  name: "carrot-manga-translator",
  version: "0.2.0",
};
const VERSION = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
type Headers = Record<string, string[] | undefined>;
type Request = {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
};

export class McpEnvelopeError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Request-local 2026 metadata; HTTP mirrors are validated before dispatch, never trusted instead of the body. */
export function validateMcpEnvelope(
  request: Request,
  headers: Headers | undefined,
  supported: readonly string[],
): boolean {
  const meta = request.params?._meta;
  const record = isObject(meta) ? meta : undefined;
  const advertised = headers ? one(headers, "mcp-protocol-version") : undefined;
  const declared = record?.[VERSION];
  const modern =
    declared !== undefined ||
    advertised === MCP_MODERN_VERSION ||
    request.method === "server/discover";
  if (!modern) {
    if (advertised !== undefined && !supported.includes(advertised))
      unsupported(advertised, supported);
    return false;
  }
  if (headers) validateMirrors(request, headers, declared);
  validateMetadata(record, declared, supported);
  return true;
}
function validateMirrors(
  request: Request,
  headers: Headers,
  declared: unknown,
): void {
  const version = one(headers, "mcp-protocol-version");
  if (
    !version ||
    version !== declared ||
    one(headers, "mcp-method") !== request.method
  )
    mismatch();
  const key = request.method === "resources/read" ? "uri" : "name";
  if (!["tools/call", "prompts/get", "resources/read"].includes(request.method))
    return;
  const name = request.params?.[key];
  if (
    typeof name !== "string" ||
    decodedName(one(headers, "mcp-name")) !== name
  )
    mismatch();
}
function validateMetadata(
  record: Record<string, unknown> | undefined,
  declared: unknown,
  supported: readonly string[],
): void {
  if (typeof declared !== "string")
    throw new McpEnvelopeError(
      -32602,
      "Request protocol metadata is required.",
    );
  if (declared !== MCP_MODERN_VERSION) unsupported(declared, supported);
  if (!isObject(record?.[CAPABILITIES]))
    throw new McpEnvelopeError(
      -32602,
      "Per-request client capabilities must be an object.",
    );
  const info = record?.["io.modelcontextprotocol/clientInfo"];
  if (info !== undefined && !validIdentity(info))
    throw new McpEnvelopeError(-32602, "Invalid per-request client identity.");
}
function validIdentity(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.version === "string" &&
    value.version.length > 0
  );
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function one(headers: Headers, key: string): string | undefined {
  const values = headers[key];
  if (values && values.length !== 1) mismatch();
  return values?.[0];
}
function mismatch(): never {
  throw new McpEnvelopeError(
    -32020,
    "Required MCP headers are missing, malformed, or do not match the request body.",
  );
}
function unsupported(requested: string, supported: readonly string[]): never {
  throw new McpEnvelopeError(-32022, "Unsupported MCP protocol version.", {
    supported,
    requested,
  });
}
function decodedName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("=?base64?") && value.endsWith("?=")) {
    const encoded = value.slice(9, -2);
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      mismatch();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) mismatch();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_error) {
      return mismatch();
    }
  }
  if (!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value)) mismatch();
  return value;
}
