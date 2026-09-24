import type { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { oauthDigest } from "../src/main/mcp/mcpOAuthPolicy";

export function createMcpTestGrant(origin: string, secret: string) {
  return function grant(provider: McpOAuthProvider, scope: string) {
    const redirect_uri = "https://chatgpt.com/connector/oauth/block-ocr-test";
    const client = provider.register({
      redirect_uris: [redirect_uri],
      token_endpoint_auth_method: "none",
    });
    const pending = provider.begin({
      client_id: client.client_id,
      response_type: "code",
      redirect_uri,
      resource: `${origin}/mcp`,
      scope,
      state: "fixture",
      code_challenge: oauthDigest(secret),
      code_challenge_method: "S256",
    });
    const response = new URL(
      provider.approve(
        {
          transaction: pending.transaction,
          decision: "approve",
          pairing_secret: secret,
        },
        pending.cookie,
      ),
    );
    return provider.token({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri,
      resource: `${origin}/mcp`,
      code: response.searchParams.get("code"),
      code_verifier: secret,
    }).access_token;
  };
}
