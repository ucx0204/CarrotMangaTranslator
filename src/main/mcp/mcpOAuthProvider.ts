import { randomBytes } from "node:crypto";
import { McpOAuthClients } from "./mcpOAuthClients";
import { McpOAuthState } from "./mcpOAuthState";
import {
  McpOAuthError,
  assertOAuthResource,
  oauthEqual,
  oauthText,
  readOAuthScope,
  readPkceChallenge,
  verifyPkce,
} from "./mcpOAuthPolicy";

type Grant = {
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
  revoked: boolean;
};
type Code = {
  grant: Grant;
  redirect: string;
  challenge: string;
  used: boolean;
};
type Pending = { code: Code; state: string; cookie: string; name: string };
type Refresh = { grant: Grant; used: boolean };
const DAY = 24 * 60 * 60 * 1000;

/** Personal development authorization server. All leases are in memory, with
 * strict resource binding. Not a multi-user identity provider or OIDC server. */
export class McpOAuthProvider {
  readonly resource: string;
  private readonly clients: McpOAuthClients;
  private readonly pending: McpOAuthState<Pending>;
  private readonly codes: McpOAuthState<Code>;
  private readonly access: McpOAuthState<Grant>;
  private readonly refresh: McpOAuthState<Refresh>;

  constructor(
    readonly issuer: string,
    private readonly pairingSecret: string,
    private readonly now: () => number = Date.now,
  ) {
    this.resource = `${issuer}/mcp`;
    this.clients = new McpOAuthClients(now);
    this.pending = new McpOAuthState(now, 64);
    this.codes = new McpOAuthState(now, 64);
    this.access = new McpOAuthState(now, 512);
    this.refresh = new McpOAuthState(now, 512);
  }

  resourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: ["carrot.read"],
      bearer_methods_supported: ["header"],
    };
  }

  authorizationMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      revocation_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
      scopes_supported: ["carrot.read", "offline_access"],
    };
  }

  register(input: Record<string, unknown>) {
    return this.clients.register(input);
  }

  begin(input: Record<string, unknown>) {
    if (input.response_type !== "code")
      throw new McpOAuthError(
        "unsupported_response_type",
        "Only authorization codes are supported.",
      );
    assertOAuthResource(input.resource, this.resource);
    const clientId = oauthText(input.client_id, 128);
    const client = this.clients.get(clientId);
    const redirect = oauthText(input.redirect_uri);
    if (!client.redirects.includes(redirect))
      throw new McpOAuthError(
        "invalid_request",
        "Callback does not match this registered client.",
      );
    const scope = readOAuthScope(input.scope);
    const cookie = randomBytes(32).toString("base64url");
    const pending: Pending = {
      cookie,
      state: oauthText(input.state),
      name: client.name,
      code: {
        redirect,
        challenge: readPkceChallenge(
          input.code_challenge,
          input.code_challenge_method,
        ),
        used: false,
        grant: {
          clientId,
          scope,
          resource: this.resource,
          expiresAt: this.now() + DAY,
          revoked: false,
        },
      },
    };
    return {
      transaction: this.pending.issue(pending, 5 * 60_000),
      cookie,
      clientName: client.name,
      scope,
      resource: this.resource,
    };
  }

  approve(input: Record<string, unknown>, cookie: string) {
    const transaction = oauthText(input.transaction, 128);
    const pending = this.pending.get(transaction);
    if (!pending || !oauthEqual(pending.cookie, cookie))
      throw new McpOAuthError(
        "invalid_request",
        "Approval expired or browser session changed. Start linking again.",
      );
    this.pending.take(transaction);
    const redirect = new URL(pending.code.redirect);
    redirect.searchParams.set("state", pending.state);
    if (input.decision === "deny") {
      redirect.searchParams.set("error", "access_denied");
      return redirect.href;
    }
    if (
      input.decision !== "approve" ||
      typeof input.pairing_secret !== "string" ||
      !oauthEqual(input.pairing_secret, this.pairingSecret)
    )
      throw new McpOAuthError(
        "access_denied",
        "Incorrect connection password. Start linking again.",
        403,
      );
    redirect.searchParams.set("code", this.codes.issue(pending.code, 60_000));
    return redirect.href;
  }

  token(input: Record<string, unknown>, authorization?: string) {
    const clientId = this.clients.authenticate(input, authorization);
    assertOAuthResource(input.resource, this.resource);
    if (input.grant_type === "authorization_code")
      return this.exchangeCode(input, clientId);
    if (input.grant_type === "refresh_token")
      return this.exchangeRefresh(input, clientId);
    throw new McpOAuthError(
      "unsupported_grant_type",
      "Unsupported grant type.",
    );
  }

  accepts(header: string): boolean {
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return false;
    const grant = this.access.get(header.slice(7));
    return (
      !!grant &&
      !grant.revoked &&
      grant.expiresAt > this.now() &&
      grant.resource === this.resource &&
      grant.scope.split(" ").includes("carrot.read")
    );
  }

  revoke(input: Record<string, unknown>, authorization?: string): void {
    const clientId = this.clients.authenticate(input, authorization);
    const token = oauthText(input.token, 128);
    const grant = this.access.get(token) ?? this.refresh.get(token)?.grant;
    if (grant?.clientId === clientId) grant.revoked = true;
  }

  close(): void {
    this.clients.clear();
    this.pending.clear();
    this.codes.clear();
    this.access.clear();
    this.refresh.clear();
  }

  private exchangeCode(input: Record<string, unknown>, clientId: string) {
    const code = this.codes.get(oauthText(input.code, 128));
    if (
      !code ||
      code.grant.clientId !== clientId ||
      code.redirect !== input.redirect_uri ||
      !verifyPkce(input.code_verifier, code.challenge)
    )
      throw new McpOAuthError(
        "invalid_grant",
        "Invalid or expired authorization code.",
      );
    if (code.used) {
      code.grant.revoked = true;
      throw new McpOAuthError(
        "invalid_grant",
        "Authorization code was already used. Reconnect.",
      );
    }
    code.used = true;
    return this.issueTokens(code.grant);
  }

  private exchangeRefresh(input: Record<string, unknown>, clientId: string) {
    const entry = this.refresh.get(oauthText(input.refresh_token, 128));
    if (!entry || entry.grant.clientId !== clientId)
      throw new McpOAuthError("invalid_grant", "Invalid refresh token.");
    if (entry.used) {
      entry.grant.revoked = true;
      throw new McpOAuthError(
        "invalid_grant",
        "Refresh replay detected. Reconnect.",
      );
    }
    if (
      input.scope !== undefined &&
      readOAuthScope(input.scope) !== entry.grant.scope
    )
      throw new McpOAuthError(
        "invalid_scope",
        "Reauthorization is required to change scope.",
      );
    entry.used = true;
    return this.issueTokens(entry.grant);
  }

  private issueTokens(grant: Grant) {
    if (grant.revoked || grant.expiresAt <= this.now())
      throw new McpOAuthError(
        "invalid_grant",
        "Authorization expired or was revoked. Reconnect.",
      );
    const lifetime = Math.min(60 * 60_000, grant.expiresAt - this.now());
    return {
      access_token: this.access.issue(grant, lifetime),
      token_type: "Bearer",
      expires_in: Math.floor(lifetime / 1000),
      refresh_token: this.refresh.issue(
        { grant, used: false },
        grant.expiresAt - this.now(),
      ),
      scope: grant.scope,
    };
  }
}
