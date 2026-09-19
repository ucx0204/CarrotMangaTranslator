const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");

/** @typedef {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} NativeApp */
/** @typedef {{assertWritable: (chapterId:string,pageId:string)=>Promise<void>, assertClean: (chapterId:string,pageId:string)=>Promise<void>, notifySaved: (chapterId:string,pageId:string)=>void}} Editing */
/** @typedef {{chapterId:string,pageId:string,revision:string,reviewRevision:string}} Target */
/** @param {string} root @param {NativeApp} app @param {Editing} editing */
async function retainedClient(root, app, editing) {
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
  const library = require(join(root, "out/main/library.js"));
  const preferences = {
    allowImages: true,
    allowEditing: true,
    allowProcessing: true,
    autoStart: false,
  };
  const session = createMcpPageOperationSession({
    origin: "https://retained.native.example",
    app,
    editing,
    preferences,
    retentionCodec: new McpSecureStore(app.appPaths.dataRoot).retentionCodec(),
    reportError: (/** @type {unknown} */ error) => console.error(error),
  });
  await session.ready();
  const tools = createMcpAppTools({
    ...editing,
    preferences,
    additionalTools: session.tools,
    wrapTool: session.wrapTool,
    withPageEdit: createMcpPageEditScope(app, library.openChapter),
  });
  /** @param {string} name @param {object} args */
  const call = async (name, args) => {
    const tool = tools.find(
      (/** @type {{name:string}} */ item) => item.name === `carrot_${name}`,
    );
    assert.ok(tool, name);
    const response = await tool.invoke(args, {
      principalId: "native-durable-fixture",
      assertAuthorized: () => {},
      assertScopes: () => {},
      assertJobAuthorized: () => {},
    });
    assert.ok(response[0]?.text, name);
    const value = JSON.parse(response[0].text);
    assert.ok(!value.error, response[0].text);
    assert.doesNotMatch(response[0].text, /imagePath|transactionId|dataUrl/);
    return value;
  };
  /** @param {string} id @param {string} direction */
  const recover = async (id, direction) => {
    const view = await call("get_change", { id });
    const pages = view.pages.map((/** @type {Target} */ item) => ({
      chapterId: item.chapterId,
      pageId: item.pageId,
      revision: item.revision,
      reviewRevision: item.reviewRevision,
    }));
    return call(`${direction}_change`, { id, requestId: randomUUID(), pages });
  };
  return {
    call,
    recover,
    artifacts: session.artifacts,
    close: () => session.close(),
  };
}

/** Uses actual Electron, encryption, renderer and native transactions. No live model/API calls.
 * @param {string} root @param {NativeApp} app @param {Editing} editing @param {string} chapterId */
async function checkNativeRetention(root, app, editing, chapterId) {
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const { capturePageRecovery } = require(
    join(root, "out/shared/pageRecoverySnapshot.js"),
  );
  const read = async () => (await library.openChapter(chapterId)).pages[0];
  const before = await read();
  const original = await readFile(before.imagePath);
  let client = await retainedClient(root, app, editing);
  try {
    await client.call("update_page_blocks", {
      chapterId,
      pageId: before.id,
      revision: createPageRevision(before),
      edits: [
        {
          blockId: before.blocks[0].id,
          fields: { translatedText: "Native durable checkpoint" },
        },
      ],
    });
    const changes = await client.call("list_changes", {});
    assert.equal(changes.total, 1);
    const id = changes.items[0].id;
    await client.close();
    client = await retainedClient(root, app, editing);
    for (const direction of ["undo", "redo", "undo"])
      assert.equal((await client.recover(id, direction)).status, "saved");
    assert.deepEqual(
      capturePageRecovery(await read()),
      capturePageRecovery(before),
    );
    const exported = await client.call("export_page_png", {
      chapterId,
      pageId: before.id,
      revision: createPageRevision(await read()),
      requestId: randomUUID(),
    });
    const result = await waitOutput(client, exported.jobId);
    assert.ok(result.retainedOutputId, "Native export must retain its file");
    const output = {
      ...result,
      ...(await client.call("get_job_file", { jobId: exported.jobId })),
    };
    const bytes = await client.artifacts.read(
      new URL(output.url).pathname.split("/")[2],
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      output.sha256,
    );
    const oldArtifacts = client.artifacts;
    await client.close();
    client = await retainedClient(root, app, editing);
    await assert.rejects(() =>
      oldArtifacts.read(new URL(output.url).pathname.split("/")[2]),
    );
    const fresh = await client.call("get_output_file", {
      id: output.retainedOutputId,
    });
    assert.notEqual(fresh.url, output.url);
    assert.deepEqual(
      await client.artifacts.read(new URL(fresh.url).pathname.split("/")[2]),
      bytes,
    );
    assert.equal((await client.call("list_outputs", {})).total, 1);
    await client.call("discard_retained", { id, confirm: true });
    await client.call("discard_retained", {
      id: output.retainedOutputId,
      confirm: true,
    });
    assert.deepEqual(await readFile(before.imagePath), original);
    assert.deepEqual(
      capturePageRecovery(await read()),
      capturePageRecovery(before),
    );
    console.log(
      "PASS native OS-encrypted durable edit -> reconstructed session undo/redo -> actual PNG -> retained byte-identical reissue without rerender",
    );
  } finally {
    await client.close();
  }
}
/** @param {Awaited<ReturnType<typeof retainedClient>>} client @param {string} jobId */
async function waitOutput(client, jobId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const job = await client.call("get_job", { jobId });
    if (job.status !== "running") {
      assert.equal(job.status, "completed", JSON.stringify(job));
      return job.result;
    }
    await pause(30);
  }
  throw new Error("Native retained export did not finish");
}
module.exports = { checkNativeRetention, retainedClient };
