const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

/** All library, lease, receipt and history code is real. The caller supplies only
 * a deterministic inference boundary in its isolated native fixture.
 * @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof import("../src/main/mcp/mcpErasureAdapter").eraseMcpPage>[1]} editing
 * @param {import("../src/main/mcp/mcpOperationTools").McpOperationTarget} target
 * @param {import("../src/main/jobs/inpaintingJobRuntime").InpaintingJobRuntime} runtime */
async function checkNativeErasureRecovery(root, app, editing, target, runtime) {
  const load = (/** @type {string} */ name) => require(join(root, "out", name));
  const library = load("main/library.js");
  const { createPageRevision } = load("shared/pageRevision.js");
  const { McpOperationService } = load(
    "main/application/mcpOperationService.js",
  );
  const { createMcpErasureRecoverySession } = load(
    "main/mcp/mcpErasureRecoverySession.js",
  );
  const { eraseMcpPage } = load("main/mcp/mcpErasureAdapter.js");
  const operations = new McpOperationService((/** @type {unknown} */ error) =>
    console.error(error),
  );
  const recovery = createMcpErasureRecoverySession(
    app,
    operations,
    editing.notifySaved,
  );
  assert.ok(recovery, "The production history must expose recovery");
  let allowed = true;
  let acquisitions = 0;
  let historyId = "";
  const context = {
    principalId: "native-recovery-fixture",
    assertAuthorized: () => assert.ok(allowed, "revoked"),
    assertScopes: (/** @type {string[]} */ scopes) => {
      assert.ok(allowed, "revoked");
      assert.ok(
        scopes.every((scope) =>
          ["carrot.read", "carrot.process"].includes(scope),
        ),
      );
    },
  };
  /** @param {string} name @param {object} args */
  const invoke = async (name, args) => {
    const tool = recovery.tools.find(
      (/** @type {{name: string}} */ tool) => tool.name === name,
    );
    assert.ok(tool, name);
    const content = await tool.invoke(args, context);
    assert.equal(content.length, 1);
    assert.equal(content[0].type, "text");
    assert.doesNotMatch(
      JSON.stringify(content),
      /resource_link|mcp-artifacts|"url"|"uri"|transactionId/,
    );
    assert.equal(JSON.stringify(content).includes(root), false);
    return JSON.parse(content[0].text);
  };
  const readPage = async () =>
    (await library.openChapter(target.chapterId)).pages.find(
      (/** @type {{id: string}} */ p) => p.id === target.pageId,
    );
  const before = await readPage();
  const original = await readFile(before.imagePath);
  const previousImage = await readFile(
    before.inpaintedImagePath ?? before.imagePath,
  );
  try {
    const started = await operations.start({
      owner: context.principalId,
      kind: "erase",
      requestId: target.requestId,
      parameters: target,
      assertAuthorized: context.assertAuthorized,
      execute: async (
        /** @type {import("../src/main/application/mcpOperationService").McpOperationContext} */ operation,
      ) =>
        eraseMcpPage(
          app,
          editing,
          target,
          operation,
          {
            ...runtime,
            acquireEngine: async (
              /** @type {Parameters<typeof runtime.acquireEngine>[0]} */ options,
            ) => {
              acquisitions++;
              return runtime.acquireEngine(options);
            },
          },
          (
            /** @type {import("../src/shared/inpaintingTypes").InpaintingHistoryTransactionRef} */ reference,
          ) => {
            historyId = reference.transactionId;
            recovery.remember(operation.id, historyId);
          },
        ),
    });
    const deadline = Date.now() + 30_000;
    while (
      operations.status(started.jobId, context.principalId).status === "running"
    ) {
      assert.ok(Date.now() < deadline, "Erasure must settle");
      await delay(10);
    }
    const result = operations.status(started.jobId, context.principalId);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.ok(historyId);
    const after = await readPage();
    const erasedImage = await readFile(after.inpaintedImagePath);
    const inspect = () =>
      invoke("carrot_get_erasure_recovery", { jobId: started.jobId });
    const ready = await inspect();
    assert.equal(ready.canUndo, true);
    const undo = {
      jobId: started.jobId,
      revision: ready.revision,
      requestId: randomUUID(),
    };
    const undone = await invoke("carrot_undo_erasure", undo);
    assert.equal(undone.pagesChanged, 1);
    const undonePage = await readPage();
    assert.deepEqual(
      await readFile(undonePage.inpaintedImagePath ?? undonePage.imagePath),
      previousImage,
    );
    assert.deepEqual(undonePage.blocks, before.blocks);
    assert.deepEqual(undonePage.blockOrder, before.blockOrder);
    assert.equal((await inspect()).canRedo, true);
    const redo = {
      jobId: started.jobId,
      revision: undone.revision,
      requestId: randomUUID(),
    };
    const redone = await invoke("carrot_redo_erasure", redo);
    assert.equal(redone.pagesChanged, 1);
    assert.deepEqual(
      await readFile((await readPage()).inpaintedImagePath),
      erasedImage,
    );
    assert.equal((await invoke("carrot_undo_erasure", undo)).pagesChanged, 0);
    assert.equal((await invoke("carrot_redo_erasure", redo)).pagesChanged, 0);
    assert.equal(
      (await inspect()).canUndo,
      true,
      "Old retries must never toggle state",
    );
    assert.equal(acquisitions, 1, "Undo/redo must never acquire a model");
    assert.deepEqual(await readFile(before.imagePath), original);
    const saved = await readPage();
    const blocks = structuredClone(saved.blocks);
    blocks[0].translatedText += " manual edit";
    await library.savePageBlocks({
      chapterId: target.chapterId,
      pageId: target.pageId,
      blocks,
      blockOrder: saved.blockOrder,
      expectedRevision: createPageRevision(saved),
    });
    assert.equal((await inspect()).state, "conflict");
    await assert.rejects(
      invoke("carrot_undo_erasure", { ...undo, requestId: randomUUID() }),
    );
    assert.equal(
      (await readPage()).blocks[0].translatedText,
      blocks[0].translatedText,
    );
    const manual = await readPage();
    await library.savePageBlocks({
      chapterId: target.chapterId,
      pageId: target.pageId,
      blocks: saved.blocks,
      blockOrder: saved.blockOrder,
      expectedRevision: createPageRevision(manual),
    });
    allowed = false;
    await assert.rejects(inspect());
    await assert.rejects(invoke("carrot_undo_erasure", undo));
    allowed = true;
    await app.inpaintingRevisionStore?.releaseTransactions?.([historyId]);
    assert.equal((await inspect()).state, "unavailable");
    console.log(
      "PASS native selected erasure -> availability -> undo -> redo; exact pixels, unchanged blocks, no extra model, retry and manual-edit protection",
    );
    return result.result;
  } finally {
    recovery.stop();
    operations.stop();
    await recovery.close();
    await operations.close();
  }
}
module.exports = { checkNativeErasureRecovery };
