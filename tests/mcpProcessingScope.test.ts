import { it, expect } from "vitest";
import { McpOAuthProvider } from "../src/main/mcp/mcpOAuthProvider";
import { oauthDigest, readOAuthScope } from "../src/main/mcp/mcpOAuthPolicy";

const origin = "https://test.tail-example.ts.net";
const callback = "https://chatgpt.com/connector/oauth/process-test";
const secret = "p".repeat(43);
function grant(allowProcessing: boolean, scope: string) {
  const provider = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
    allowEdits: true,
    allowProcessing,
  });
  const client = provider.register({
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
  });
  const pending = provider.begin({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    scope,
    state: "state",
    code_challenge_method: "S256",
    code_challenge: oauthDigest(secret),
  });
  const redirect = new URL(
    provider.approve(
      {
        transaction: pending.transaction,
        decision: "approve",
        pairing_secret: secret,
      },
      pending.cookie,
    ),
  );
  const tokens = provider.token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code: redirect.searchParams.get("code"),
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    code_verifier: secret,
  });
  return { provider, tokens };
}
it("requires separate process opt-in and never turns old text edit grants into page processing grants", () => {
  expect(() =>
    readOAuthScope("carrot.read carrot.process", true, true),
  ).toThrow();
  expect(readOAuthScope("carrot.read carrot.process", false, false, true)).toBe(
    "carrot.read carrot.process",
  );
  const old = grant(false, "carrot.read carrot.edit");
  const restored = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
    allowEdits: true,
    allowProcessing: true,
  });
  restored.restore(old.provider.snapshot());
  expect(
    restored.accepts(`Bearer ${old.tokens.access_token}`, "carrot.process"),
  ).toBe(false);
});
it("persists explicitly approved process scope without resetting old approvals", () => {
  const f = grant(true, "carrot.read carrot.process");
  const restored = new McpOAuthProvider(origin, secret, Date.now, {
    persistent: true,
    allowProcessing: true,
  });
  restored.restore(JSON.parse(JSON.stringify(f.provider.snapshot())));
  expect(
    restored.accepts(`Bearer ${f.tokens.access_token}`, "carrot.process"),
  ).toBe(true);
  expect(
    restored.accepts(`Bearer ${f.tokens.access_token}`, "carrot.edit"),
  ).toBe(false);
});
