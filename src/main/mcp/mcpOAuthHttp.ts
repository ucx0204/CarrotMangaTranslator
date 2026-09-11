import type { IncomingMessage, ServerResponse } from "node:http";
import { McpOAuthProvider } from "./mcpOAuthProvider";
import type { McpOAuthSession } from "./mcpOAuthSession";
import {
  McpOAuthError,
  oauthRecord,
  uniqueOAuthParams,
} from "./mcpOAuthPolicy";
import { mcpOAuthConsentPage } from "./mcpOAuthPage";
import { readBoundedBody, readMcpBody } from "./mcpRequestBody";

const COOKIE = "__Host-carrot-link";
const GET_PATHS = [
  "/",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/authorize",
];
const POST_PATHS = [
  "/oauth/register",
  "/oauth/approve",
  "/oauth/token",
  "/oauth/revoke",
];

export class McpOAuthHttp {
  readonly provider: McpOAuthProvider;
  private windowStarted = 0;
  private requests = 0;

  constructor(
    issuer: string,
    password: string,
    private readonly session?: McpOAuthSession,
  ) {
    this.provider = session?.provider ?? new McpOAuthProvider(issuer, password);
    if (this.provider.issuer !== issuer)
      throw new Error("OAuth issuer mismatch.");
  }

  accepts(header: string, scope = "carrot.read"): boolean {
    return this.session
      ? this.session.accepts(header, scope)
      : this.provider.accepts(header, scope);
  }

  stop(): void {
    this.session?.stop();
  }

  async close(): Promise<void> {
    if (this.session) await this.session.close();
    else this.provider.close();
  }

  private async mutate<T>(action: () => T): Promise<T> {
    return this.session ? this.session.run(action) : action();
  }

  challenge(): string {
    return `Bearer resource_metadata="${this.provider.issuer}/.well-known/oauth-protected-resource/mcp", scope="carrot.read"`;
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", this.provider.issuer);
    if (![...GET_PATHS, ...POST_PATHS].includes(url.pathname)) return false;
    secureResponse(response);
    try {
      this.limitRequests();
      if (request.method === "GET" && GET_PATHS.includes(url.pathname)) {
        this.get(url, response);
      } else if (
        request.method === "POST" &&
        POST_PATHS.includes(url.pathname)
      ) {
        if (url.search)
          throw new McpOAuthError(
            "invalid_request",
            "POST parameters belong in the request body.",
          );
        await this.post(url.pathname, request, response);
      } else {
        response.setHeader(
          "Allow",
          GET_PATHS.includes(url.pathname) ? "GET" : "POST",
        );
        throw new McpOAuthError("invalid_request", "Method not allowed.", 405);
      }
    } catch (error) {
      if (!(error instanceof McpOAuthError)) throw error;
      if (error.status === 429) response.setHeader("Retry-After", "60");
      sendJson(response, error.status, {
        error: error.code,
        error_description: error.message,
      });
    }
    return true;
  }

  private get(url: URL, response: ServerResponse): void {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      sendJson(response, 200, this.provider.resourceMetadata());
    } else if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(response, 200, this.provider.authorizationMetadata());
    } else if (url.pathname === "/oauth/authorize") {
      const consent = this.provider.begin(uniqueOAuthParams(url.searchParams));
      response.setHeader(
        "Set-Cookie",
        `${COOKIE}=${consent.cookie}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`,
      );
      // no-referrer makes a native form POST send Origin:null, which our CSRF
      // guard correctly rejects. Preserve same-origin form provenance instead;
      // cross-origin referrers remain suppressed. The 303 response keeps the
      // default no-referrer policy so the callback never receives consent URLs.
      response.setHeader("Referrer-Policy", "same-origin");
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(mcpOAuthConsentPage(consent));
    } else {
      sendJson(response, 200, {
        service: "Carrot MCP",
        mode: "read-only",
        authentication: "OAuth",
        endpoint: this.provider.resource,
      });
    }
  }

  private async post(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (path === "/oauth/register") {
      requireContentType(request, "application/json");
      const input = oauthRecord(await readMcpBody(request));
      sendJson(
        response,
        201,
        await this.mutate(() => this.provider.register(input)),
      );
      return;
    }
    requireContentType(request, "application/x-www-form-urlencoded");
    const input = uniqueOAuthParams(
      new URLSearchParams(await readForm(request)),
    );
    if (path === "/oauth/approve") {
      if (request.headers.origin !== this.provider.issuer)
        throw new McpOAuthError(
          "access_denied",
          "Approval must come from this server's consent page.",
          403,
        );
      const cookies = (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${COOKIE}=`));
      if (cookies.length !== 1)
        throw new McpOAuthError(
          "access_denied",
          "Approval cookie is required.",
          403,
        );
      const redirect = await this.mutate(() =>
        this.provider.approve(input, cookies[0].slice(COOKIE.length + 1)),
      );
      response.setHeader(
        "Set-Cookie",
        `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      );
      response.writeHead(303, { Location: redirect });
      response.end();
    } else {
      const authorization = readAuthorization(request);
      if (path === "/oauth/token")
        sendJson(
          response,
          200,
          await this.mutate(() => this.provider.token(input, authorization)),
        );
      else {
        await this.mutate(() => this.provider.revoke(input, authorization));
        sendJson(response, 200, {});
      }
    }
  }

  private limitRequests(): void {
    const now = Date.now();
    if (now - this.windowStarted >= 60_000) {
      this.windowStarted = now;
      this.requests = 0;
    }
    if (++this.requests > 120)
      throw new McpOAuthError(
        "temporarily_unavailable",
        "Too many OAuth requests. Retry in a minute.",
        429,
      );
  }
}

function requireContentType(request: IncomingMessage, expected: string): void {
  const types = request.headersDistinct["content-type"];
  if (
    !types ||
    types.length !== 1 ||
    types[0].split(";")[0].trim().toLowerCase() !== expected ||
    request.headers["content-encoding"] !== undefined
  )
    throw new McpOAuthError(
      "invalid_request",
      "Unsupported content type or encoding.",
      415,
    );
}

function readAuthorization(request: IncomingMessage): string | undefined {
  const values = request.headersDistinct.authorization;
  if (values && values.length !== 1)
    throw new McpOAuthError(
      "invalid_client",
      "Duplicate authentication headers.",
      401,
    );
  return values?.[0];
}

async function readForm(request: IncomingMessage): Promise<string> {
  const bytes = await readBoundedBody(request);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (_error) {
    throw new McpOAuthError("invalid_request", "Invalid UTF-8 form.");
  }
}

function secureResponse(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  // The only cross-origin form navigation is the strictly validated OAuth callback.
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
  );
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
