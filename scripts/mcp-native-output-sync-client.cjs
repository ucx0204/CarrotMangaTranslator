const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { mkdir } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const {
  approveOutputSyncFixture,
  outputSyncIssuer,
  outputSyncPreferences,
} = require("./mcp-native-output-sync-auth.cjs");

/** @typedef {import("./mcp-native-exchange-client.cjs").NativeApp} NativeApp */
/** @typedef {import("./mcp-native-exchange-client.cjs").Editing} Editing */
/** @typedef {import("../src/main/linkedWorkspace/linkedWorkspaceReviewedOutputTypes").ReviewedLinkedOutputPort} NativePort */
/** @typedef {{accessToken:string, connectionId:string}} Credentials */
/** @typedef {Awaited<ReturnType<typeof outputSyncNativeClient>>} Client */

/** Real HTTP + scope enforcement + restored OS-encrypted OAuth and job journal.
 * @param {string} root @param {NativeApp} app @param {Editing} editing
 * @param {NativePort} native @param {Credentials} [credentials] */
async function outputSyncNativeClient(root, app, editing, native, credentials) {
  assert.equal(app.appPaths.dataRoot, root, "Never use a real profile");
  const { McpSecureStore } = require(
    join(root, "out/main/mcp/mcpSecureStore.js"),
  );
  const { McpDesktopAuthorization } = require(
    join(root, "out/main/mcp/mcpDesktopAuthorization.js"),
  );
  const { createMcpPageOperationSession } = require(
    join(root, "out/main/mcp/mcpPageOperationSession.js"),
  );
  const { createMcpAppTools } = require(
    join(root, "out/main/mcp/mcpAppTools.js"),
  );
  const { createMcpPageEditScope } = require(
    join(root, "out/main/mcp/mcpPageEditScope.js"),
  );
  const { startMcpHttpServer } = require(
    join(root, "out/main/mcp/mcpHttpServer.js"),
  );
  const library = require(join(root, "out/main/library.js"));
  for (const name of ["native-output-sync-auth", "native-output-sync-journal"])
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  const authorization = new McpDesktopAuthorization(
    new McpSecureStore(join(root, "native-output-sync-auth")),
  );
  const auth = await authorization.open(
    outputSyncIssuer,
    outputSyncPreferences,
  );
  /** @type {ReturnType<typeof import("../src/main/mcp/mcpPageOperationSession").createMcpPageOperationSession> | undefined} */
  let session;
  /** @type {import("../src/main/mcp/mcpHttpServer").McpHttpServer | undefined} */
  let server;
  try {
    const identity = credentials ?? (await approveOutputSyncFixture(auth));
    assert.equal(
      auth.session.accepts(`Bearer ${identity.accessToken}`, "carrot.process"),
      true,
    );
    const journal = new McpSecureStore(
      join(root, "native-output-sync-journal"),
    );
    /** @type {unknown[]} */
    const errors = [];
    session = createMcpPageOperationSession({
      origin: outputSyncIssuer,
      app,
      editing,
      outputSync: native,
      preferences: outputSyncPreferences,
      retentionCodec: new McpSecureStore(root).retentionCodec(),
      jobPersistence: {
        load: () => journal.readJobJournal(),
        save: (/** @type {unknown} */ value) => journal.writeJobJournal(value),
      },
      reportError: (/** @type {unknown} */ error) => errors.push(error),
    });
    assert.ok(session);
    await session.ready();
    const tools = createMcpAppTools({
      ...editing,
      preferences: outputSyncPreferences,
      additionalTools: session.tools,
      wrapTool: session.wrapTool,
      withPageEdit: createMcpPageEditScope(app, library.openChapter),
    });
    server = await startMcpHttpServer({
      config: {
        port: 0,
        token: randomBytes(32).toString("base64url"),
        publicOrigin: outputSyncIssuer,
      },
      tools,
      oauthHttp: auth.http,
      enforceScopes: true,
      artifacts: session.artifacts,
      reportError: (/** @type {unknown} */ error) => errors.push(error),
    });
    assert.ok(server);
    const activeServer = server;
    const activeSession = session;
    const call = outputSyncHttpCaller(activeServer.url, identity.accessToken);
    /** @type {Promise<void> | undefined} */
    let closing;
    const close = () => {
      activeServer.stopAccepting();
      activeSession.stop();
      closing ??= closeOutputSyncClient(activeServer, activeSession);
      return closing;
    };
    return {
      call,
      errors,
      credentials: identity,
      close,
      journal: () => journal.readJobJournal(),
      revoke: () => authorization.revoke(identity.connectionId),
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
      "Native output sync client initialization failed",
      { cause: error },
    );
  }
}

/** @param {string} url @param {string} token */
function outputSyncHttpCaller(url, token) {
  /** @param {string} name @param {object} args */
  return async (name, args) => {
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
        method: "tools/call",
        params: { name: `carrot_${name}`, arguments: args },
      }),
    });
    assert.equal(response.status, 200);
    const reply = await response.json();
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    const result = reply.result;
    assert.equal(
      result.isError,
      false,
      JSON.stringify(result.structuredContent),
    );
    assert.ok(
      result.structuredContent,
      "Registered tool must validate its output schema",
    );
    assert.deepEqual(
      result.structuredContent,
      JSON.parse(result.content[0].text),
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /relativePath|imagePath|transactionId|dataUrl|mcp-artifacts|resource_link/,
    );
    return result.structuredContent;
  };
}

/** @param {Client} client @param {string} jobId */
async function waitOutputSyncJob(client, jobId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = await client.call("get_job", { jobId });
    if (job.status !== "running") return job;
    await pause(25);
  }
  throw new Error("Native output synchronization did not settle");
}

/** @param {{close:()=>Promise<void>}} server @param {{close:()=>Promise<void>}} session */
async function closeOutputSyncClient(server, session) {
  const results = await Promise.allSettled([server.close(), session.close()]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(
      errors,
      "Native output sync fixture cleanup failed",
    );
}
module.exports = { outputSyncNativeClient, waitOutputSyncJob };
