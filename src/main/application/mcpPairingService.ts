import { randomInt, randomUUID } from "node:crypto";
import type { McpPairingRequest } from "../../shared/mcpDesktopTypes";
import type { McpOAuthProvider } from "../mcp/mcpOAuthProvider";
import type { McpOAuthSession } from "../mcp/mcpOAuthSession";
import { McpOAuthError, oauthEqual } from "../mcp/mcpOAuthPolicy";

type Pending = McpPairingRequest & {
  transaction: string;
  cookie: string;
  decision?: boolean;
  completion?: Promise<string>;
};

/** Only the trusted desktop IPC can resolve a request. The display code is not a credential. */
export class McpPairingService {
  private until = 0;
  private readonly requests = new Map<string, Pending>();
  constructor(
    private readonly provider: McpOAuthProvider,
    private readonly session: McpOAuthSession,
    private readonly password: string,
    private readonly now: () => number = Date.now,
  ) {}
  open(): void {
    this.until = this.now() + 5 * 60_000;
  }
  assertOpen(): void {
    if (this.until <= this.now())
      throw new McpOAuthError(
        "access_denied",
        "Open New AI connection in the Carrot app first.",
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
    const entry: Pending = {
      id: randomUUID(),
      code: String(randomInt(100000, 1000000)),
      clientName: consent.clientName,
      scope: consent.scope,
      expiresAt: this.now() + 5 * 60_000,
      transaction: consent.transaction,
      cookie: consent.cookie,
    };
    this.requests.set(entry.id, entry);
    return { ...this.view(entry), cookie: entry.cookie };
  }
  status() {
    this.prune();
    return {
      pairingUntil: this.until > this.now() ? this.until : null,
      pending: [...this.requests.values()]
        .filter((entry) => entry.decision === undefined)
        .map((entry) => this.view(entry)),
    };
  }
  resolve(id: string, approved: boolean): void {
    const entry = this.require(id);
    if (entry.decision !== undefined)
      throw new Error("This connection request was already decided.");
    entry.decision = approved;
  }
  async poll(
    id: string,
    cookie: string,
  ): Promise<{ request: McpPairingRequest; redirect?: string }> {
    const entry = this.require(id);
    if (!oauthEqual(cookie, entry.cookie))
      throw new McpOAuthError(
        "access_denied",
        "The browser session does not match.",
        403,
      );
    if (entry.decision === undefined) return { request: this.view(entry) };
    entry.completion ??= this.session.run(() =>
      this.provider.approve(
        {
          transaction: entry.transaction,
          decision: entry.decision ? "approve" : "deny",
          pairing_secret: this.password,
        },
        entry.cookie,
      ),
    );
    return { request: this.view(entry), redirect: await entry.completion };
  }
  close(): void {
    this.until = 0;
    this.requests.clear();
  }
  private require(id: string): Pending {
    this.prune();
    const entry = this.requests.get(id);
    if (!entry)
      throw new McpOAuthError(
        "invalid_request",
        "Connection request expired. Start linking again.",
      );
    return entry;
  }
  private view(entry: Pending): McpPairingRequest {
    return {
      id: entry.id,
      code: entry.code,
      clientName: entry.clientName,
      scope: entry.scope,
      expiresAt: entry.expiresAt,
    };
  }
  private prune(): void {
    for (const [id, entry] of this.requests)
      if (entry.expiresAt <= this.now()) this.requests.delete(id);
  }
}
