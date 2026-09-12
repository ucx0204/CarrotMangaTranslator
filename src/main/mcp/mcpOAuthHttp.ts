import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpOAuthSession } from "./mcpOAuthSession";
import type { McpPairingBroker } from "./mcpPairingBroker";
import { mcpPairingPage } from "./mcpPairingPage";
import { McpOAuthProvider } from "./mcpOAuthProvider";
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
  "/oauth/poll",
  "/oauth/complete",
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
    private readonly managed?: {
      session: McpOAuthSession;
      pairing: McpPairingBroker;
    },
  ) {
    this.provider =
      managed?.session.provider ?? new McpOAuthProvider(issuer, password);
  }
  async ready(): Promise<void> {
    await this.managed?.session.ready();
  }
  scopeFor(header: string): string | undefined {
    return this.managed
      ? this.managed.session.scopeFor(header)
      : this.provider.scopeFor(header);
  }
  stop(): void {
    this.managed?.pairing.close();
    if (this.managed) this.managed.session.stop();
    else this.provider.close();
  }
  async close(): Promise<void> {
    this.stop();
    await this.managed?.session.close();
  }
  private async commit<T>(action: () => T): Promise<T> {
    return this.managed ? this.managed.session.run(action) : action();
  }

  challenge(): string {
    return `Bearer resource_metadata="${this.provider.issuer}/.well-known/oauth-protected-resource/mcp", scope="${this.provider.resourceMetadata().scopes_supported.join(" ")}"`;
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
      const input = uniqueOAuthParams(url.searchParams);
      const consent = this.managed
        ? this.managed.pairing.begin(input)
        : this.provider.begin(input);
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
      if ("code" in consent && typeof consent.code === "string") {
        const page = mcpPairingPage({ ...consent, code: consent.code });
        response.setHeader(
          "Content-Security-Policy",
          `default-src 'none'; script-src 'nonce-${page.nonce}'; connect-src 'self'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'`,
        );
        response.end(page.html);
      } else response.end(mcpOAuthConsentPage(consent));
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
      this.managed?.pairing.assertOpen();
      requireContentType(request, "application/json");
      const input = oauthRecord(await readMcpBody(request));
      sendJson(
        response,
        201,
        await this.commit(() => this.provider.register(input)),
      );
      return;
    }
    requireContentType(request, "application/x-www-form-urlencoded");
    const input = uniqueOAuthParams(
      new URLSearchParams(await readForm(request)),
    );
    if (["/oauth/approve", "/oauth/poll", "/oauth/complete"].includes(path)) {
      await this.browserPost(path, request, response, input);
      return;
    }
    const authorization = readAuthorization(request);
    const result = await this.commit(() => {
      if (path === "/oauth/token")
        return this.provider.token(input, authorization);
      this.provider.revoke(input, authorization);
      return {};
    });
    sendJson(response, 200, result);
  }

  private async browserPost(
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
    input: Record<string, string>,
  ): Promise<void> {
    const cookie = readBrowserCookie(request, this.provider.issuer);
    if (path === "/oauth/poll" && this.managed) {
      sendJson(response, 200, {
        status: this.managed.pairing.poll(input.transaction, cookie),
      });
      return;
    }
    let redirect: string;
    if (path === "/oauth/complete" && this.managed) {
      const pairing = this.managed.pairing;
      redirect = await this.commit(() =>
        pairing.complete(input.transaction, cookie),
      );
    } else if (path === "/oauth/approve" && !this.managed) {
      redirect = await this.commit(() => this.provider.approve(input, cookie));
    } else
      throw new McpOAuthError(
        "access_denied",
        "Use the local app approval flow.",
        403,
      );
    response.setHeader(
      "Set-Cookie",
      `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    );
    response.writeHead(303, { Location: redirect });
    response.end();
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

function readBrowserCookie(request: IncomingMessage, issuer: string): string {
  if (request.headers.origin !== issuer)
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
  return cookies[0].slice(COOKIE.length + 1);
}
