import { randomBytes } from "node:crypto";
import { McpOAuthError, oauthDigest } from "./mcpOAuthPolicy";

/** Token digests only. Durable callers explicitly snapshot validated, encrypted state. */
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
      expiresAt: Math.min(Number.MAX_SAFE_INTEGER, this.now() + lifetimeMs),
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

  snapshot(): { key: string; value: T; expiresAt: number }[] {
    this.prune();
    return [...this.entries].map(([key, entry]) => ({ key, ...entry }));
  }

  restore(entries: { key: string; value: T; expiresAt: number }[]): void {
    if (
      entries.length > this.capacity ||
      new Set(entries.map((entry) => entry.key)).size !== entries.length
    )
      throw new Error("Invalid OAuth store capacity or duplicate keys.");
    this.entries.clear();
    for (const { key, value, expiresAt } of entries) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !Number.isSafeInteger(expiresAt))
        throw new Error("Invalid OAuth store entry.");
      if (expiresAt > this.now()) this.entries.set(key, { value, expiresAt });
    }
  }

  private prune(): void {
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
  }
}
