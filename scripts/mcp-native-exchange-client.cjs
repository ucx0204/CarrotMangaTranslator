const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { subscribe, unsubscribe } = require("node:diagnostics_channel");
const { mkdir } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { app: electronApp } = require("electron");

/** @typedef {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} NativeApp */
/** @typedef {Parameters<typeof import("./mcp-native-retention.cjs").retainedClient>[2]} Editing */
/** @typedef {Awaited<ReturnType<typeof exchangeNativeClient>>} Client */

/** Actual registered tools, OS encryption and an owned journal isolated from the parent's open session.
 * @param {string} root @param {NativeApp} app @param {Editing} editing
 * @param {{owner?: string}} [options] */
async function exchangeNativeClient(root, app, editing, options = {}) {
  assert.equal(app.appPaths.dataRoot, root, "Never use a real profile");
  const { createMcpPageOperationSession } = require(
    join(root, "out/main/mcp/mcpPageOperationSession.js"),
  );
  const { createMcpAppTools } = require(
    join(root, "out/main/mcp/mcpAppTools.js"),
  );
  const { createMcpPageEditScope } = require(
    join(root, "out/main/mcp/mcpPageEditScope.js"),
  );
  const { McpSecureStore } = require(
    join(root, "out/main/mcp/mcpSecureStore.js"),
  );
  const { mcpToolResult } = require(
    join(root, "out/main/mcp/mcpToolResult.js"),
  );
  const { McpEditError } = require(
    join(root, "out/main/application/mcpEditPolicy.js"),
  );
  const library = require(join(root, "out/main/library.js"));
  const journalRoot = join(
    root,
    options.owner
      ? "native-exchange-foreign-journal"
      : "native-exchange-journal",
  );
  await mkdir(journalRoot, { recursive: true, mode: 0o700 });
  const journal = new McpSecureStore(journalRoot);
  const preferences = {
    allowImages: false,
    allowEditing: true,
    allowProcessing: true,
    autoStart: false,
  };
  /** @type {unknown[]} */
  const errors = [];
  const session = createMcpPageOperationSession({
    origin: "https://exchange.native.example",
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
  await session.ready();
  const tools = createMcpAppTools({
    ...editing,
    preferences,
    additionalTools: session.tools,
    wrapTool: session.wrapTool,
    withPageEdit: createMcpPageEditScope(app, library.openChapter),
  });
  let authorized = true;
  const guard = () => {
    if (!authorized)
      throw new McpEditError(
        "access_denied",
        "Native fixture connection revoked",
      );
  };
  /** @type {Set<string>} */
  const requestedScopes = new Set();
  /** @param {readonly string[]} scopes */
  const scopes = (scopes) => {
    guard();
    for (const scope of scopes) {
      requestedScopes.add(scope);
      if (!["carrot.read", "carrot.edit", "carrot.process"].includes(scope))
        throw new McpEditError(
          "access_denied",
          "Native fixture scope not granted",
        );
    }
  };
  /** @param {string} name @param {object} args */
  const call = async (name, args) => {
    const tool = tools.find(
      (/** @type {{name: string}} */ item) => item.name === `carrot_${name}`,
    );
    assert.ok(tool, `Missing registered carrot_${name}`);
    const response = await tool.invoke(args, {
      principalId: options.owner ?? "native-exchange-fixture",
      assertAuthorized: guard,
      assertScopes: scopes,
      assertJobAuthorized: scopes,
    });
    const result = mcpToolResult(tool, response);
    assert.equal(result.isError, false, JSON.stringify(response));
    assert.ok(result.structuredContent, `Missing output contract for ${name}`);
    assert.doesNotMatch(
      JSON.stringify(result.structuredContent),
      /imagePath|transactionId|dataUrl/,
    );
    return result.structuredContent;
  };
  /** @param {string} id @param {string} direction */
  const recover = async (id, direction) => {
    const change = await call("get_change", { id });
    const pages = change.pages.map(
      (
        /** @type {{chapterId:string,pageId:string,revision:string,reviewRevision:string}} */ page,
      ) => ({
        chapterId: page.chapterId,
        pageId: page.pageId,
        revision: page.revision,
        reviewRevision: page.reviewRevision,
      }),
    );
    return call(`${direction}_change`, { id, requestId: randomUUID(), pages });
  };
  /** @type {Promise<void> | undefined} */
  let closing;
  return {
    call,
    recover,
    artifacts: session.artifacts,
    errors,
    scopes: requestedScopes,
    revoke: () => {
      authorized = false;
    },
    journal: () => journal.readJobJournal(),
    close: () => {
      closing ??= session.close();
      return closing;
    },
  };
}

/** @param {Client} client @param {string} jobId */
async function waitExchangeJob(client, jobId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = await client.call("get_job", { jobId });
    assert.doesNotMatch(
      JSON.stringify(job),
      /mcp-artifacts|resource_link|"url"/,
    );
    if (job.status !== "running") return job;
    await pause(25);
  }
  throw new Error("Native exchange job did not settle");
}

/** @param {string} root @param {Client} client */
async function exchangeArtifactHttp(root, client) {
  const { startMcpHttpServer } = require(
    join(root, "out/main/mcp/mcpHttpServer.js"),
  );
  /** @type {unknown[]} */
  const errors = [];
  const server = await startMcpHttpServer({
    config: { port: 0, token: randomUUID().repeat(2) },
    tools: [],
    artifacts: client.artifacts,
    reportError: (/** @type {unknown} */ error) => errors.push(error),
  });
  /** @type {Promise<void> | undefined} */
  let closing;
  return {
    origin: new URL(server.url).origin,
    errors,
    close: () => {
      closing ??= server.close();
      return closing;
    },
  };
}

/** Observe real work without replacing a renderer, parser, store or native writer.
 * @param {NativeApp} app */
function observeExchangeWork(app) {
  /** @type {Set<string>} */
  const jobs = new Set();
  /** @type {Set<string>} */
  const jobKinds = new Set();
  let windows = 0;
  const created = () => {
    windows++;
  };
  const unsubscribe = app.jobs.gate.subscribe(() => {
    for (const activity of app.jobs.gate.activities)
      if (activity.category === "job") {
        jobs.add(activity.id);
        jobKinds.add(activity.kind);
      }
  });
  electronApp.on("browser-window-created", created);
  return {
    jobs,
    jobKinds,
    windows: () => windows,
    stop: () => {
      unsubscribe();
      electronApp.off("browser-window-created", created);
    },
  };
}
/** Await the actual server finish after consuming the client body, without polling or altering observers.
 * @template T
 * @param {string} origin @param {string} url @param {"GET" | "HEAD"} method
 * @param {() => Promise<T>} consume
 * @returns {Promise<T>} */
async function completeExchangeResponse(origin, url, method, consume) {
  const pathname = new URL(url).pathname;
  const port = Number(new URL(origin).port);
  /** @type {(response: import("node:http").ServerResponse) => void} */
  let resolve = () => {};
  /** @type {Promise<import("node:http").ServerResponse>} */
  const finished = new Promise((complete) => {
    resolve = complete;
  });
  /** @param {unknown} message */
  const observed = (message) => {
    const event =
      /** @type {{request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse}} */ (
        message
      );
    if (
      event.request.url !== pathname ||
      event.request.method !== method ||
      event.request.socket.localPort !== port
    )
      return;
    unsubscribe("http.server.response.finish", observed);
    resolve(event.response);
  };
  subscribe("http.server.response.finish", observed);
  try {
    const result = await consume();
    const response = await finished;
    assert.equal(response.writableFinished, true);
    return result;
  } finally {
    unsubscribe("http.server.response.finish", observed);
  }
}
module.exports = {
  exchangeNativeClient,
  waitExchangeJob,
  exchangeArtifactHttp,
  observeExchangeWork,
  completeExchangeResponse,
};
