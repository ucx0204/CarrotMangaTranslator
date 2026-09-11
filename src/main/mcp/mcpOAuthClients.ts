import { randomBytes } from "node:crypto";
import type { McpOAuthSnapshot } from "./mcpOAuthSnapshot";
import { McpOAuthState } from "./mcpOAuthState";
import {
  McpOAuthError,
  oauthDigest,
  oauthEqual,
  oauthText,
  readChatGptRedirect,
} from "./mcpOAuthPolicy";

type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";
type Client = {
  name: string;
  redirects: string[];
  method: AuthMethod;
  secretHash?: string;
};
const CLIENT_LIFETIME = 7 * 24 * 60 * 60 * 1000;

export class McpOAuthClients {
  private readonly clients: McpOAuthState<Client>;
  constructor(
    private readonly now: () => number,
    private readonly persistent = false,
  ) {
    this.clients = new McpOAuthState(now, 64);
  }
  register(input: Record<string, unknown>) {
    const redirects = readRedirects(input.redirect_uris);
    const method = input.token_endpoint_auth_method ?? "client_secret_basic";
    if (
      method !== "none" &&
      method !== "client_secret_post" &&
      method !== "client_secret_basic"
    )
      throw new McpOAuthError(
        "invalid_client_metadata",
        "Unsupported token authentication method.",
      );
    checkList(input.grant_types, ["authorization_code", "refresh_token"]);
    checkList(input.response_types, ["code"]);
    const name =
      input.client_name === undefined
        ? "ChatGPT"
        : oauthText(input.client_name, 120);
    const secret =
      method === "none" ? undefined : randomBytes(32).toString("base64url");
    const id = this.clients.issue(
      { name, redirects, method, secretHash: secret && oauthDigest(secret) },
      CLIENT_LIFETIME,
    );
    return {
      client_id: id,
      client_id_issued_at: Math.floor(this.now() / 1000),
      ...(secret
        ? {
            client_secret: secret,
            client_secret_expires_at: this.persistent
              ? 0
              : Math.floor((this.now() + CLIENT_LIFETIME) / 1000),
          }
        : {}),
      client_name: name,
      redirect_uris: redirects,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "carrot.read offline_access",
    };
  }
  get(id: string): Client {
    const client = this.clients.get(id);
    if (!client)
      throw new McpOAuthError(
        "invalid_client",
        "Unknown or expired client. Reconnect the plugin.",
        401,
      );
    return client;
  }
  authenticate(input: Record<string, unknown>, authorization?: string): string {
    const supplied = authorization
      ? readBasic(authorization)
      : {
          id: oauthText(input.client_id, 128),
          secret: input.client_secret,
          method:
            input.client_secret === undefined ? "none" : "client_secret_post",
        };
    if (authorization && input.client_secret !== undefined)
      throw new McpOAuthError(
        "invalid_client",
        "Use one client authentication method.",
        401,
      );
    if (
      authorization &&
      input.client_id !== undefined &&
      input.client_id !== supplied.id
    )
      throw new McpOAuthError(
        "invalid_client",
        "Client authentication failed.",
        401,
      );
    const client = this.get(supplied.id);
    if (client.method !== supplied.method)
      throw new McpOAuthError(
        "invalid_client",
        "Client authentication method mismatch.",
        401,
      );
    if (
      client.secretHash &&
      (typeof supplied.secret !== "string" ||
        !oauthEqual(oauthDigest(supplied.secret), client.secretHash))
    )
      throw new McpOAuthError(
        "invalid_client",
        "Client authentication failed.",
        401,
      );
    return supplied.id;
  }
  remember(id: string): void {
    if (this.persistent) this.clients.remember(id);
  }
  snapshot(): McpOAuthSnapshot["clients"] {
    return this.clients.snapshot((value) => ({ ...value }));
  }
  restore(records: McpOAuthSnapshot["clients"]): void {
    this.clients.restore(records, (value) => ({ ...value }));
  }
  clear(): void {
    this.clients.clear();
  }
}
function checkList(value: unknown, allowed: string[]): void {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > allowed.length ||
    value.some((item) => !allowed.includes(item))
  )
    throw new McpOAuthError(
      "invalid_client_metadata",
      "Unsupported grant or response type.",
    );
}
function readBasic(header: string) {
  if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(header))
    throw new McpOAuthError(
      "invalid_client",
      "Invalid client authentication.",
      401,
    );
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1)
    throw new McpOAuthError(
      "invalid_client",
      "Invalid client authentication.",
      401,
    );
  return {
    id: decoded.slice(0, separator),
    secret: decoded.slice(separator + 1),
    method: "client_secret_basic",
  };
}

function readRedirects(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    throw new McpOAuthError(
      "invalid_client_metadata",
      "One to four ChatGPT callbacks are required.",
    );
  return value.map(readChatGptRedirect);
}
