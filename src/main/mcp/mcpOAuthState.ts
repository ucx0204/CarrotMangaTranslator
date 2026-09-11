import { randomBytes } from "node:crypto";
import { McpOAuthError, oauthDigest } from "./mcpOAuthPolicy";

/** Only digests are keys. No token is persisted or logged. Restart revokes all leases. */
export class McpOAuthState<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly now: () => number,
    private readonly capacity = 256,
  ) {}

  issue(value: T, lifetimeMs: number): string {
    this.prune();
    if (this.entries.size >= this.capacity)
      throw new McpOAuthError(
        "temporarily_unavailable",
        "OAuth capacity reached. Retry later or restart the local test server.",
        503,
      );
    const secret = randomBytes(32).toString("base64url");
    this.entries.set(oauthDigest(secret), {
      value,
      expiresAt: this.now() + lifetimeMs,
    });
    return secret;
  }

  get(secret: string): T | undefined {
    this.prune();
    return this.entries.get(oauthDigest(secret))?.value;
  }

  take(secret: string): T | undefined {
    const value = this.get(secret);
    this.entries.delete(oauthDigest(secret));
    return value;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
  }
}
