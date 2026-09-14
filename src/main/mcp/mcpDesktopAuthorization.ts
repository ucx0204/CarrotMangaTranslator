import { randomBytes } from "node:crypto";
import type {
  McpConnection,
  McpPreferences,
} from "../../shared/mcpDesktopTypes";
import { McpOAuthProvider } from "./mcpOAuthProvider";
import { McpOAuthSession } from "./mcpOAuthSession";
import { McpPairingBroker } from "./mcpPairingBroker";
import { McpOAuthHttp } from "./mcpOAuthHttp";
import type { McpSecureStore } from "./mcpSecureStore";

/** Owns restoration, local revocation while offline, and durable session construction. */
export class McpDesktopAuthorization {
  constructor(private readonly store: McpSecureStore) {}
  async status() {
    const provider = await this.readProvider();
    if (!provider) return { url: null, connections: [] as McpConnection[] };
    try {
      return { url: provider.resource, connections: provider.connections() };
    } finally {
      provider.close();
    }
  }
  async revoke(id: string): Promise<void> {
    const provider = await this.readProvider();
    if (!provider) throw new Error("저장된 연결이 없습니다.");
    try {
      provider.revokeConnection(id);
      await this.store.saveAuthorization(provider.snapshot());
    } finally {
      provider.close();
    }
  }
  async open(issuer: string, preferences: McpPreferences) {
    const secrets = await this.store.load();
    const secret = randomBytes(32).toString("base64url");
    const provider = new McpOAuthProvider(issuer, secret, Date.now, {
      persistent: true,
      allowEdits: preferences.allowEditing,
      allowImages: preferences.allowImages,
      allowProcessing: preferences.allowProcessing === true,
    });
    if (secrets.oauth) provider.restore(secrets.oauth);
    const session = new McpOAuthSession(provider, {
      save: (state) => this.store.saveAuthorization(state),
    });
    await session.run(() => undefined);
    const pairing = new McpPairingBroker(provider, secret);
    return {
      provider,
      session,
      pairing,
      localToken: secrets.localToken,
      http: new McpOAuthHttp(issuer, secret, { session, pairing }),
    };
  }
  private async readProvider(): Promise<McpOAuthProvider | null> {
    const secrets = await this.store.load();
    if (!secrets.oauth) return null;
    const provider = new McpOAuthProvider(secrets.oauth.issuer, "", Date.now, {
      persistent: true,
    });
    provider.restore(secrets.oauth);
    return provider;
  }
}
