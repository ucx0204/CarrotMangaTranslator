const { randomBytes, createHash } = require("node:crypto");

/** @param {string} endpoint @param {string} password @param {string} [expectedOrigin] */
async function runMcpWebProbe(endpoint, password, expectedOrigin = new URL(endpoint).origin) {
  const wireOrigin = new URL(endpoint).origin;
  const resource = `${expectedOrigin}/mcp`;
  /** @param {string} path @param {RequestInit} [init] */
  const send = (path, init = {}) => fetch(`${wireOrigin}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const denied = await send("/mcp");
  requireCondition(denied.status === 401 && !!denied.headers.get("www-authenticate")?.includes("resource_metadata="), "Unauthenticated MCP request must return an OAuth challenge.");
  const metadata = await send("/.well-known/oauth-protected-resource/mcp").then(readJson);
  requireCondition(metadata.resource === resource && metadata.authorization_servers?.[0] === expectedOrigin, "Protected-resource metadata does not match this endpoint.");
  const auth = await send("/.well-known/oauth-authorization-server").then(readJson);
  for (const [name, path] of Object.entries({ issuer: "", authorization_endpoint: "/oauth/authorize", token_endpoint: "/oauth/token", registration_endpoint: "/oauth/register" }))
    requireCondition(auth[name] === `${expectedOrigin}${path}`, "Unexpected OAuth endpoint. No credentials were sent.");
  console.log("PASS public OAuth discovery and unauthenticated access rejection");
  const client = await send("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Carrot connection diagnostic", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }) }).then(readJson);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: CALLBACK, response_type: "code", resource, state, scope: "carrot.read offline_access", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
  const consent = await send(`/oauth/authorize?${query}`);
  requireCondition(consent.status === 200, "Could not open the consent page.");
  const cookie = consent.headers.get("set-cookie")?.split(";")[0] ?? "";
  const transaction = (await consent.text()).match(/name="transaction" value="([A-Za-z0-9_-]{43})"/)?.[1];
  requireCondition(!!transaction && cookie.startsWith("__Host-carrot-link="), "Consent session is incomplete.");
  const approved = await send("/oauth/approve", { method: "POST", headers: { Origin: expectedOrigin, Cookie: cookie }, body: new URLSearchParams({ transaction: transaction ?? "", pairing_secret: password, decision: "approve" }) });
  requireCondition(approved.status === 303, "Connection password was not accepted. Use the current web-launcher password.");
  const callback = new URL(approved.headers.get("location") ?? "invalid:");
  requireCondition(`${callback.origin}${callback.pathname}` === CALLBACK && callback.searchParams.get("state") === state, "OAuth callback or state mismatch.");
  const tokens = await send("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, resource, redirect_uri: CALLBACK, code: callback.searchParams.get("code") ?? "", code_verifier: verifier }) }).then(readJson);
  console.log("PASS consent cookie, connection password and PKCE code exchange");
  await exerciseGrant(send, client.client_id, resource, tokens);
  console.log("PASS web connection diagnostic complete; no Codex or model API was used");
}

const CALLBACK = "https://chatgpt.com/connector/oauth/carrot-connection-diagnostic";
/** @typedef {{access_token: string, refresh_token: string}} Tokens */
/** @typedef {(path: string, init?: RequestInit) => Promise<Response>} Send */

/** @param {Send} send @param {string} clientId @param {string} resource @param {Tokens} initial */
async function exerciseGrant(send, clientId, resource, initial) {
  let tokens = initial;
  /** @type {unknown} */
  let failure;
  try {
    tokens = await send("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, resource, refresh_token: tokens.refresh_token }) }).then(readJson);
    requireCondition(tokens.refresh_token !== initial.refresh_token, "Refresh tokens were not rotated.");
    console.log("PASS refresh-token rotation");
    await exerciseTools(send, tokens.access_token);
  } catch (error) { failure = error; }
  try {
    const revoked = await send("/oauth/revoke", { method: "POST", body: new URLSearchParams({ client_id: clientId, token: tokens.refresh_token }) });
    requireCondition(revoked.status === 200, "Diagnostic grant revocation failed.");
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], "Diagnostic and grant cleanup both failed.", { cause: error });
    throw error;
  }
  if (failure) throw failure;
  const denied = await send("/mcp", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  requireCondition(denied.status === 401, "Revoked access token was accepted.");
  console.log("PASS diagnostic grant revoked; app data was not modified");
}

/** @param {Send} send @param {string} token */
async function exerciseTools(send, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
  /** @param {string} method @param {object} [params] */
  const rpc = async (method, params = {}) => {
    const body = await send("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(readJson);
    requireCondition(!body.error && body.result && !body.result.isError, "An authenticated MCP request failed.");
    return body.result;
  };
  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "carrot-web-diagnostic", version: "1" } });
  const notification = await send("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  requireCondition(notification.status === 202, "MCP initialization notification failed.");
  const tools = await rpc("tools/list");
  requireCondition(Array.isArray(tools.tools) && tools.tools.length >= 4, "Missing MCP tools.");
  const capabilities = await rpc("tools/call", { name: "carrot_get_capabilities", arguments: {} });
  const info = JSON.parse(capabilities.content[0].text);
  requireCondition(info.oauth === true && info.mode === "read-only", "Server is not advertising the web test profile.");
  await rpc("tools/call", { name: "carrot_list_works", arguments: { limit: 1 } });
  console.log(`PASS authenticated MCP handshake, ${tools.tools.length} tools, capabilities and library read`);
}

/** @param {Response} response */
async function readJson(response) {
  requireCondition(response.ok, `OAuth/MCP request returned HTTP ${response.status}.`);
  return response.json();
}

/** @param {unknown} condition @param {string} message */
function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

module.exports = { runMcpWebProbe };
