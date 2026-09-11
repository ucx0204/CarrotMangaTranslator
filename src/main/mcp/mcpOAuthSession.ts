import type { McpOAuthProvider } from "./mcpOAuthProvider";
import type { McpOAuthSnapshot } from "./mcpOAuthSnapshot";

type Persistence = { save: (state: McpOAuthSnapshot) => Promise<void> };
/** A successful token/registration/revocation response always follows durable commit.
 * Even failed replay requests can revoke a family, so those mutations are committed too. */
export class McpOAuthSession {
  private tail: Promise<void> = Promise.resolve();
  private fault: unknown;
  private stopped = false;
  constructor(readonly provider: McpOAuthProvider, private readonly persistence: Persistence) {}
  async run<T>(action: () => T): Promise<T> {
    if (this.stopped) throw new Error("MCP authorization is stopped.");
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.fault || this.stopped) throw new Error("MCP authorization is unavailable.", { cause: this.fault });
      return await this.commit(action);
    } finally { release(); }
  }
  accepts(header: string): boolean { return !this.fault && !this.stopped && this.provider.accepts(header); }
  stop(): void { this.stopped = true; }
  async close(): Promise<void> { this.stop(); await this.tail; this.provider.close(); }
  private async commit<T>(action: () => T): Promise<T> {
    let result: T | undefined;
    let failure: unknown;
    try { result = action(); } catch (error) { failure = error; }
    try { await this.persistence.save(this.provider.snapshot()); }
    catch (error) {
      this.fault = error;
      if (failure) throw new AggregateError([failure, error], "OAuth operation and durable commit failed.", { cause: error });
      throw error;
    }
    if (failure) throw failure;
    return result as T;
  }
}
