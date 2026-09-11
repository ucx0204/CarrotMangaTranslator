import { randomBytes } from "node:crypto";
import type { McpSecureStore } from "./mcpSecureStore";
import { McpOAuthProvider } from "./mcpOAuthProvider";
/** Offline management never starts a listener or tunnel. Caller serializes it with the online lease. */
export async function rememberedMcpConnections(
  store: McpSecureStore,
  revokeId?: string,
) {
  const snapshot = await store.savedAuthorization();
  if (!snapshot) return { url: null, connections: [] };
  const provider = new McpOAuthProvider(
    snapshot.issuer,
    randomBytes(32).toString("base64url"),
    Date.now,
    { persistent: true },
  );
  try {
    provider.restore(snapshot);
    if (revokeId) {
      provider.revokeConnection(revokeId);
      await store.saveAuthorization(provider.snapshot());
    }
    return { url: provider.resource, connections: provider.connections() };
  } finally {
    provider.close();
  }
}
