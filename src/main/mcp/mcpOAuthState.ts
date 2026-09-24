import { randomBytes } from "node:crypto";
import { McpOAuthError, oauthDigest } from "./mcpOAuthPolicy";

/** Token keys are digests. Optional snapshots never contain plaintext bearer tokens. */
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
  snapshot<U>(
    mapValue: (value: T) => U,
  ): { digest: string; value: U; expiresAt: number }[] {
    this.prune();
    return [...this.entries].map(([digest, item]) => ({
      digest,
      expiresAt: item.expiresAt,
      value: mapValue(item.value),
    }));
  }
  restore<U>(
    records: readonly { digest: string; value: U; expiresAt: number }[],
    mapValue: (value: U) => T,
  ): void {
    if (records.length > this.capacity)
      throw new Error("OAuth snapshot exceeds capacity.");
    const entries = new Map<string, { value: T; expiresAt: number }>();
    for (const item of records) {
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(item.digest) ||
        entries.has(item.digest) ||
        !Number.isSafeInteger(item.expiresAt)
      )
        throw new Error("Invalid OAuth state record.");
      entries.set(item.digest, {
        value: mapValue(item.value),
        expiresAt: item.expiresAt,
      });
    }
    this.entries.clear();
    for (const [key, value] of entries) this.entries.set(key, value);
    this.prune();
  }
  remember(secret: string): void {
    const entry = this.entries.get(oauthDigest(secret));
    if (!entry) throw new Error("OAuth client no longer exists.");
    entry.expiresAt = Number.MAX_SAFE_INTEGER;
  }
  clear(): void {
    this.entries.clear();
  }
  private prune(): void {
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
  }
}
