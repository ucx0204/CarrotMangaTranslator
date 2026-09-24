const assert = require("node:assert/strict");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { mkdir } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const {
  completeExchangeResponse,
} = require("./mcp-native-exchange-client.cjs");
const {
  approveCompositeFixture,
  compositeIssuer,
  compositePreferences,
} = require("./mcp-native-composite-auth.cjs");

/** @typedef {import("./mcp-native-exchange-client.cjs").NativeApp} NativeApp */
/** @typedef {import("./mcp-native-exchange-client.cjs").Editing} Editing */
/** @typedef {{accessToken:string, connectionId:string}} Credentials */
/** @typedef {Awaited<ReturnType<typeof compositeNativeClient>>} Client */

/** Actual registered tools, OS-encrypted OAuth/retention/journal and scoped loopback HTTP.
 * @param {string} root @param {NativeApp} app @param {Editing} editing
 * @param {{credentials?:Credentials, scope?:string, allowImages?:boolean}} [options] */
async function compositeNativeClient(root, app, editing, options = {}) {
  assert.equal(app.appPaths.dataRoot, root, "Never use a real profile");
  const { McpSecureStore } = require(
    join(root, "out/main/mcp/mcpSecureStore.js"),
  );
  const { McpDesktopAuthorization } = require(
    join(root, "out/main/mcp/mcpDesktopAuthorization.js"),
  );
  /** @type {typeof import("../src/main/mcp/mcpPageOperationSession")} */
  const { createMcpPageOperationSession } = require(
    join(root, "out/main/mcp/mcpPageOperationSession.js"),
  );
  const { createMcpAppTools } = require(
    join(root, "out/main/mcp/mcpAppTools.js"),
  );
  const { createMcpPageEditScope } = require(
    join(root, "out/main/mcp/mcpPageEditScope.js"),
  );
  /** @type {typeof import("../src/main/mcp/mcpHttpServer")} */
  const { startMcpHttpServer } = require(
    join(root, "out/main/mcp/mcpHttpServer.js"),
  );
  const library = require(join(root, "out/main/library.js"));
  const preferences = {
    ...compositePreferences,
    allowImages: options.allowImages ?? true,
  };
  for (const name of ["native-composite-auth", "native-composite-journal"])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const authorization = new McpDesktopAuthorization(
    new McpSecureStore(join(root, "native-composite-auth")),
  );
  const auth = await authorization.open(compositeIssuer, preferences);
  const journal = new McpSecureStore(join(root, "native-composite-journal"));
  /** @type {ReturnType<typeof import("../src/main/mcp/mcpPageOperationSession").createMcpPageOperationSession> | undefined} */
  let session;
  /** @type {import("../src/main/mcp/mcpHttpServer").McpHttpServer | undefined} */
  let server;
  try {
    const credentials =
      options.credentials ??
      (await approveCompositeFixture(auth, options.scope));
    assert.equal(
      auth.session.accepts(`Bearer ${credentials.accessToken}`, "carrot.read"),
      true,
    );
    /** @type {unknown[]} */
    const errors = [];
    const activeSession = createMcpPageOperationSession({
      origin: compositeIssuer,
      app,
      editing,
      preferences,
      retentionCodec: new McpSecureStore(root).retentionCodec(),
      jobPersistence: {
        load: () => journal.readJobJournal(),
        save: (/** @type {unknown} */ value) => journal.writeJobJournal(value),
      },
      reportError: (/** @type {unknown} */ error) => errors.push(error),
    });
    session = activeSession;
    await activeSession.ready();
    const tools = createMcpAppTools({
      ...editing,
      preferences,
      additionalTools: activeSession.tools,
      wrapTool: activeSession.wrapTool,
      bindNativeTools: activeSession.bindNativeTools,
      withPageEdit: createMcpPageEditScope(app, library.openChapter),
    });
    const activeServer = await startMcpHttpServer({
      config: {
        port: 0,
        token: randomBytes(32).toString("base64url"),
        publicOrigin: compositeIssuer,
      },
      tools,
      oauthHttp: auth.http,
      enforceScopes: true,
      artifacts: activeSession.artifacts,
      reportError: (/** @type {unknown} */ error) => errors.push(error),
    });
    server = activeServer;
    const request = compositeHttpRequest(
      activeServer.url,
      credentials.accessToken,
    );
    /** @param {string} name @param {object} args */
    const response = async (name, args) => {
      const result = await request("tools/call", {
        name: `carrot_${name}`,
        arguments: args,
      });
      assert.equal(
        result.isError,
        false,
        JSON.stringify(result.structuredContent),
      );
      assert.ok(
        result.structuredContent,
        `Registered output schema required: ${name}`,
      );
      assert.deepEqual(
        result.structuredContent,
        JSON.parse(result.content[0].text),
      );
      if (name.includes("composite"))
        assertCompositePrivacy(result.structuredContent, root);
      return result;
    };
    /** @param {string} name @param {object} args */
    const call = async (name, args) =>
      (await response(name, args)).structuredContent;
    /** @param {string} name @param {object} args */
    const denied = async (name, args) => {
      const result = await request("tools/call", {
        name: `carrot_${name}`,
        arguments: args,
      });
      assert.equal(
        result.isError,
        true,
        `Expected denied native tool: ${name}`,
      );
      assertCompositePrivacy(result.structuredContent, root);
      return result.structuredContent;
    };
    /** @type {Promise<void> | undefined} */
    let closing;
    const close = () => {
      activeServer.stopAccepting();
      activeSession.stop();
      closing ??= closeCompositeClient(activeServer, activeSession);
      return closing;
    };
    return {
      call,
      response,
      denied,
      credentials,
      errors,
      close,
      origin: new URL(activeServer.url).origin,
      journal: () => journal.readJobJournal(),
      listTools: () => request("tools/list", {}),
      revoke: () => authorization.revoke(credentials.connectionId),
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      server ? server.close() : auth.http.close(),
      session?.close(),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    throw new AggregateError(
      [error, ...failures],
      "Native composite client initialization failed",
      { cause: error },
    );
  }
}
/** @param {string} url @param {string} token */
function compositeHttpRequest(url, token) {
  /** @param {string} method @param {object} params */
  return async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      }),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  };
}
/** @param {unknown} value @param {string} root */
function assertCompositePrivacy(value, root) {
  const text = JSON.stringify(value);
  assert.ok(
    !text.includes(root) && !text.includes(root.replaceAll("\\", "/")),
    "Public composite metadata leaked the fixture root",
  );
  assert.doesNotMatch(
    text,
    /imagePath|transactionId|dataUrl|mcp-artifacts|resource_link|nativeReference|membershipFingerprint|memoryFingerprint/,
  );
}
/** @param {Client} client @param {string} id */
async function waitComposite(client, id) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const parent = await client.call("get_composite", { id });
    if (parent.status !== "running") return parent;
    await pause(25);
  }
  throw new Error("Native composite phase did not settle");
}
/** @param {Client} client @param {{url:string,mimeType:string,bytes:number,sha256:string}} file */
async function downloadCompositeFile(client, file) {
  const url = client.origin + new URL(file.url).pathname;
  const head = await completeExchangeResponse(client.origin, url, "HEAD", () =>
    fetch(url, { method: "HEAD", redirect: "error" }),
  );
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(file.bytes));
  assert.equal(await head.text(), "");
  return completeExchangeResponse(client.origin, url, "GET", async () => {
    const response = await fetch(url, { redirect: "error" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), file.mimeType);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    return bytes;
  });
}
/** @param {{close:()=>Promise<void>}} server @param {{close:()=>Promise<void>}} session */
async function closeCompositeClient(server, session) {
  const results = await Promise.allSettled([server.close(), session.close()]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, "Native composite fixture cleanup failed");
}
module.exports = {
  compositeNativeClient,
  waitComposite,
  downloadCompositeFile,
};
