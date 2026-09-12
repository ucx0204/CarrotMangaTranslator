import { randomInt } from "node:crypto";
import type { McpPairingRequest } from "../../shared/mcpDesktopTypes";
import { McpOAuthError, oauthEqual } from "./mcpOAuthPolicy";
import type { McpOAuthProvider } from "./mcpOAuthProvider";

type Pending = McpPairingRequest & {
  cookie: string;
  decision: "pending" | "approved" | "denied";
};

/** Local approval is deliberately not an MCP tool. A browser must retain its own
 * HttpOnly cookie and PKCE verifier; the display code alone grants no access. */
export class McpPairingBroker {
  private until = 0;
  private readonly requests = new Map<string, Pending>();
  constructor(
    private readonly provider: McpOAuthProvider,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {}
  open(): void {
    this.until = this.now() + 5 * 60_000;
  }
  assertOpen(): void {
    if (this.until <= this.now())
      throw new McpOAuthError(
        "access_denied",
        "Open Settings > AI connection > Allow a new connection in the Carrot app first.",
        403,
      );
  }
  begin(input: Record<string, unknown>) {
    this.assertOpen();
    this.prune();
    if (this.requests.size >= 8)
      throw new McpOAuthError(
        "temporarily_unavailable",
        "Too many pending connections.",
        429,
      );
    const consent = this.provider.begin(input);
    const code = String(randomInt(100000, 1000000));
    this.requests.set(consent.transaction, {
      id: consent.transaction,
      clientName: consent.clientName,
      cookie: consent.cookie,
      scope: consent.scope,
      code,
      expiresAt: this.now() + 5 * 60_000,
      decision: "pending",
    });
    return { ...consent, code };
  }
  status() {
    this.prune();
    return {
      pairingUntil: this.until > this.now() ? this.until : null,
      pending: [...this.requests.values()]
        .filter((item) => item.decision === "pending")
        .map(({ cookie: _cookie, decision: _decision, ...item }) => item),
    };
  }
  resolve(id: string, approve: boolean): void {
    this.prune();
    const request = this.requests.get(id);
    if (!request || request.decision !== "pending")
      throw new Error(
        "This connection request expired or was already handled.",
      );
    request.decision = approve ? "approved" : "denied";
  }
  poll(id: string, cookie: string): Pending["decision"] {
    return this.requireBrowser(id, cookie).decision;
  }
  complete(id: string, cookie: string): string {
    const request = this.requireBrowser(id, cookie);
    if (request.decision === "pending")
      throw new McpOAuthError(
        "access_denied",
        "Approve or deny the request in the Carrot app first.",
        403,
      );
    this.requests.delete(id);
    return this.provider.approve(
      {
        transaction: id,
        decision: request.decision === "approved" ? "approve" : "deny",
        pairing_secret: this.secret,
      },
      cookie,
    );
  }
  close(): void {
    this.until = 0;
    this.requests.clear();
  }
  private requireBrowser(id: string, cookie: string): Pending {
    this.prune();
    const request = this.requests.get(id);
    if (!request || !oauthEqual(request.cookie, cookie))
      throw new McpOAuthError(
        "access_denied",
        "The browser connection expired. Start linking again.",
        403,
      );
    return request;
  }
  private prune(): void {
    for (const [id, request] of this.requests)
      if (request.expiresAt <= this.now()) this.requests.delete(id);
  }
}
