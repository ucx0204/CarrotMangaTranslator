const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");

const compositeIssuer = "https://composite.native.example";
const compositePreferences = {
  allowImages: true,
  allowEditing: true,
  allowProcessing: true,
  autoStart: false,
};
const callback = "https://chatgpt.com/connector/oauth/carrot-composite-fixture";

/** Approve only the real isolated native fixture's grant; never a user profile.
 * @param {Awaited<ReturnType<import("../src/main/mcp/mcpDesktopAuthorization").McpDesktopAuthorization["open"]>>} auth
 * @param {string} [scope] */
async function approveCompositeFixture(
  auth,
  scope = "carrot.read carrot.images carrot.edit carrot.process offline_access",
) {
  const client = await auth.session.run(() =>
    auth.provider.register({
      client_name: "Isolated native composite acceptance",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    }),
  );
  const verifier = randomBytes(32).toString("base64url");
  const consent = auth.pairing.begin({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: callback,
    resource: `${compositeIssuer}/mcp`,
    state: "owned-composite-fixture",
    scope,
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
      resource: `${compositeIssuer}/mcp`,
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
  approveCompositeFixture,
  compositeIssuer,
  compositePreferences,
};
