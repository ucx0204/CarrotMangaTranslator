const assert = require("node:assert/strict");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { BrowserWindow } = require("electron");

/** @typedef {{status: number, origin: string | undefined, location: string | undefined, policy: string | undefined}} FormReply */
/** @typedef {{origin: string, clientId: string, verifier: string, state: string, callback: string}} Flow */

/** Run only against the isolated synthetic-library server owned by the native smoke.
 * Never inject an Origin/Cookie header: Chromium must generate both from the actual page.
 * @param {string} origin @param {string} password */
async function runMcpBrowserConsentProbe(origin, password) {
  assert.equal(new URL(origin).protocol, "https:");
  const flow = await registerFlow(origin);
  const legacy = await submitConsent(flow, password, "approve", true);
  assert.equal(legacy.origin, "null");
  assert.equal(legacy.status, 403);
  console.log(
    "PASS browser reproduces the old no-referrer / Origin:null rejection",
  );

  const approved = await submitConsent(flow, password, "approve", false);
  assert.equal(approved.origin, origin);
  assert.equal(approved.status, 303);
  assert.equal(approved.policy, "no-referrer");
  const redirect = checkedRedirect(approved, flow);
  assert.ok(redirect.searchParams.get("code"));
  assert.equal(redirect.searchParams.has("error"), false);
  await exchangeAndRevoke(flow, redirect.searchParams.get("code") ?? "");
  console.log(
    "PASS real browser consent preserves Origin; PKCE code exchange and revocation succeed",
  );

  const denied = await submitConsent(flow, "", "deny", false);
  assert.equal(denied.origin, origin);
  assert.equal(denied.status, 303);
  assert.equal(denied.policy, "no-referrer");
  const denial = checkedRedirect(denied, flow);
  assert.equal(denial.searchParams.get("error"), "access_denied");
  assert.equal(denial.searchParams.has("code"), false);
  console.log(
    "PASS real browser cancellation returns access_denied without a code",
  );
}

/** @param {string} origin @returns {Promise<Flow>} */
async function registerFlow(origin) {
  const callback = "https://chatgpt.com/connector/oauth/carrot-browser-smoke";
  const response = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Carrot synthetic browser regression",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(response.status, 201);
  const registered = await response.json();
  assert.equal(typeof registered.client_id, "string");
  return {
    origin,
    callback,
    clientId: registered.client_id,
    verifier: randomBytes(32).toString("base64url"),
    state: randomUUID(),
  };
}

/** @param {Flow} flow */
function authorizationUrl(flow) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: flow.clientId,
    redirect_uri: flow.callback,
    resource: `${flow.origin}/mcp`,
    state: flow.state,
    scope: "carrot.read",
    code_challenge: createHash("sha256")
      .update(flow.verifier)
      .digest("base64url"),
    code_challenge_method: "S256",
  });
  return `${flow.origin}/oauth/authorize?${query}`;
}

/** @param {Flow} flow @param {string} password @param {"approve" | "deny"} decision
 * @param {boolean} legacy @returns {Promise<FormReply>} */
async function submitConsent(flow, password, decision, legacy) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: `carrot-mcp-browser-${randomUUID()}`,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const browserSession = window.webContents.session;
  const observation = observeForm(window, flow.origin, legacy);
  try {
    await window.loadURL(authorizationUrl(flow));
    // Execute a DOM click, not fetch/form emulation. The password is never logged.
    await window.webContents.executeJavaScript(
      `document.getElementById("password").value = ${JSON.stringify(password)};
       document.querySelector('button[value="${decision}"]').click();`,
      true,
    );
    const deadline = Date.now() + 15_000;
    while (!observation.reply && Date.now() < deadline) await delay(50);
    assert.ok(
      observation.reply,
      "Browser form submission did not return a response",
    );
    return observation.reply;
  } finally {
    window.destroy();
    browserSession.webRequest.onBeforeRequest(null);
    browserSession.webRequest.onBeforeSendHeaders(null);
    browserSession.webRequest.onHeadersReceived(null);
    await browserSession.clearStorageData();
    await browserSession.closeAllConnections();
  }
}

/** Observe real browser headers and responses without altering requests. Only the
 * negative fixture restores the historical response policy. Never contact ChatGPT.
 * @param {import("electron").BrowserWindow} window @param {string} origin @param {boolean} legacy */
function observeForm(window, origin, legacy) {
  /** @type {{origin?: string, reply?: FormReply}} */
  const observed = {};
  const browserSession = window.webContents.session;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  browserSession.setPermissionRequestHandler((_contents, _permission, done) =>
    done(false),
  );
  browserSession.webRequest.onBeforeRequest((details, done) => {
    done({ cancel: new URL(details.url).origin !== origin });
  });
  browserSession.webRequest.onBeforeSendHeaders((details, done) => {
    if (details.url === `${origin}/oauth/approve`)
      observed.origin = findHeader(details.requestHeaders, "origin");
    done({});
  });
  browserSession.webRequest.onHeadersReceived((details, done) => {
    const headers = { ...details.responseHeaders };
    if (legacy && new URL(details.url).pathname === "/oauth/authorize") {
      for (const key of Object.keys(headers))
        if (key.toLowerCase() === "referrer-policy") delete headers[key];
      headers["Referrer-Policy"] = ["no-referrer"];
    }
    if (details.url === `${origin}/oauth/approve`)
      observed.reply = {
        status: details.statusCode,
        origin: observed.origin,
        location: findHeader(headers, "location"),
        policy: findHeader(headers, "referrer-policy"),
      };
    done({ responseHeaders: headers });
  });
  return observed;
}

/** @param {Record<string, string | string[]>} headers @param {string} name */
function findHeader(headers, name) {
  const value = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  return Array.isArray(value) ? value[0] : value;
}

/** @param {FormReply} reply @param {Flow} flow */
function checkedRedirect(reply, flow) {
  assert.ok(reply.location);
  const redirect = new URL(reply.location);
  assert.equal(`${redirect.origin}${redirect.pathname}`, flow.callback);
  assert.equal(redirect.searchParams.get("state"), flow.state);
  return redirect;
}

/** @param {Flow} flow @param {string} code */
async function exchangeAndRevoke(flow, code) {
  const response = await fetch(`${flow.origin}/oauth/token`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: flow.clientId,
      redirect_uri: flow.callback,
      resource: `${flow.origin}/mcp`,
      code_verifier: flow.verifier,
      code,
    }),
  });
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.equal(typeof tokens.access_token, "string");
  const revoked = await fetch(`${flow.origin}/oauth/revoke`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    body: new URLSearchParams({
      client_id: flow.clientId,
      token: tokens.refresh_token,
    }),
  });
  assert.equal(revoked.status, 200);
}

module.exports = { runMcpBrowserConsentProbe };
