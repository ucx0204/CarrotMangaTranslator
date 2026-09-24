const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");

const outputSyncIssuer = "https://output-sync.native.example";
const callback =
  "https://chatgpt.com/connector/oauth/carrot-output-sync-fixture";
const outputSyncPreferences = {
  allowImages: true,
  allowEditing: true,
  allowProcessing: true,
  autoStart: false,
};

/** Only the isolated native fixture approves this actual OS-encrypted grant.
 * @param {Awaited<ReturnType<import("../src/main/mcp/mcpDesktopAuthorization").McpDesktopAuthorization["open"]>>} auth */
async function approveOutputSyncFixture(auth) {
  const client = await auth.session.run(() =>
    auth.provider.register({
      client_name: "Isolated native output sync acceptance",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    }),
  );
  const verifier = randomBytes(32).toString("base64url");
  const consent = auth.pairing.begin({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: callback,
    resource: `${outputSyncIssuer}/mcp`,
    state: "owned-output-sync-fixture",
    scope:
      "carrot.read carrot.images carrot.edit carrot.process offline_access",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  assert.throws(() =>
    auth.pairing.complete(consent.transaction, consent.cookie),
  );
  auth.pairing.resolve(consent.transaction, true);
  const redirect = new URL(
    auth.pairing.complete(consent.transaction, consent.cookie),
  );
  const tokens = await auth.session.run(() =>
    auth.provider.token({
      grant_type: "authorization_code",
      client_id: client.client_id,
      resource: `${outputSyncIssuer}/mcp`,
      redirect_uri: callback,
      code: redirect.searchParams.get("code"),
      code_verifier: verifier,
    }),
  );
  const connectionId = auth.provider.connectionIdFor(
    `Bearer ${tokens.access_token}`,
  );
  assert.ok(connectionId);
  return { accessToken: tokens.access_token, connectionId };
}
module.exports = {
  approveOutputSyncFixture,
  outputSyncIssuer,
  outputSyncPreferences,
};
