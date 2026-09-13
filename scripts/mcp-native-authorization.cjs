const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");
const { mkdir, readFile } = require("node:fs/promises");
const { join } = require("node:path");

const issuer = "https://carrot-native-test.tail-test.ts.net";
const callback = "https://chatgpt.com/connector/oauth/carrot-native-test";
const preferences = { allowImages: true, allowEditing: true, autoStart: false };

/** Real compiled services and OS encryption, using only the caller's isolated fixture.
 * This checks fresh service/store instances, not a logged-in ChatGPT session. */
/** @param {string} dataRoot */
async function checkNativeAuthorization(dataRoot) {
  const { McpSecureStore } = require(
    join(dataRoot, "out/main/mcp/mcpSecureStore.js"),
  );
  const { McpDesktopAuthorization } = require(
    join(dataRoot, "out/main/mcp/mcpDesktopAuthorization.js"),
  );
  const directory = join(dataRoot, "native-auth-fixture");
  await mkdir(directory, { recursive: true });
  const create = () =>
    new McpDesktopAuthorization(new McpSecureStore(directory));
  const first = await create().open(issuer, preferences);
  let linked;
  try {
    linked = await approveFixture(first);
    assert.equal(
      first.session.accepts(`Bearer ${linked.tokens.access_token}`),
      true,
    );
  } finally {
    await first.http.close();
  }
  const encrypted = await readFile(
    join(directory, "mcp-private/authorization.enc"),
    "utf8",
  );
  for (const value of [
    linked.tokens.access_token,
    linked.tokens.refresh_token,
    linked.clientId,
  ])
    assert.equal(encrypted.includes(value), false);
  const second = await create().open(issuer, preferences);
  let renewed;
  let grantId;
  try {
    assert.equal(
      second.session.accepts(
        `Bearer ${linked.tokens.access_token}`,
        "carrot.edit",
      ),
      true,
    );
    renewed = await second.session.run(() =>
      second.provider.token({
        grant_type: "refresh_token",
        client_id: linked.clientId,
        resource: `${issuer}/mcp`,
        refresh_token: linked.tokens.refresh_token,
      }),
    );
    assert.notEqual(renewed.refresh_token, linked.tokens.refresh_token);
    grantId = second.provider.connections()[0].id;
  } finally {
    await second.http.close();
  }
  const offline = create();
  await offline.revoke(grantId);
  assert.equal((await offline.status()).connections[0].revoked, true);
  const third = await create().open(issuer, preferences);
  try {
    assert.equal(
      third.session.accepts(`Bearer ${renewed.access_token}`),
      false,
    );
    await assert.rejects(
      third.session.run(() =>
        third.provider.token({
          grant_type: "refresh_token",
          client_id: linked.clientId,
          resource: `${issuer}/mcp`,
          refresh_token: renewed.refresh_token,
        }),
      ),
    );
  } finally {
    await third.http.close();
  }
  console.log(
    "PASS native OS-encrypted OAuth restore, refresh and offline revocation",
  );
}

/** @param {{session: {run: <T>(action: () => T) => Promise<T>}, provider: {register: (input: object) => {client_id: string}, token: (input: object) => {access_token: string, refresh_token: string}}, pairing: {open: () => void, begin: (input: object) => {transaction: string, cookie: string}, resolve: (id: string, approve: boolean) => void, complete: (id: string, cookie: string) => string}}} auth */
async function approveFixture(auth) {
  auth.pairing.open();
  const client = await auth.session.run(() =>
    auth.provider.register({
      client_name: "Isolated native authorization test",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    }),
  );
  const verifier = randomBytes(32).toString("base64url");
  const consent = auth.pairing.begin({
    client_id: client.client_id,
    response_type: "code",
    redirect_uri: callback,
    resource: `${issuer}/mcp`,
    state: "native-fixture",
    scope: "carrot.read carrot.images carrot.edit offline_access",
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
  assert.equal(redirect.searchParams.get("state"), "native-fixture");
  const tokens = await auth.session.run(() =>
    auth.provider.token({
      grant_type: "authorization_code",
      client_id: client.client_id,
      resource: `${issuer}/mcp`,
      redirect_uri: callback,
      code: redirect.searchParams.get("code"),
      code_verifier: verifier,
    }),
  );
  return { clientId: client.client_id, tokens };
}

module.exports = { checkNativeAuthorization };
