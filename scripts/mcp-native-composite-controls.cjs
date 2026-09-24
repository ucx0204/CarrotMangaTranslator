const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const {
  compositeNativeClient,
  waitComposite,
  downloadCompositeFile,
} = require("./mcp-native-composite-client.cjs");
const {
  compositeMutation,
  compositeNoModelBudget,
  bindCompositePhase,
  runCompositePhase,
  executeCompositePhase,
  compositeChild,
} = require("./mcp-native-composite-phases.cjs");
const { compositeImagesAction } = require("./mcp-native-composite-outputs.cjs");
const {
  readCompositeReviewImages,
  compositeHostReport,
} = require("./mcp-native-composite-review.cjs");

/** @typedef {import("./mcp-native-composite-client.cjs").Client} Client */
/** @typedef {import("./mcp-native-composite-phases.cjs").Parent} Parent */
/** @typedef {ReturnType<typeof import("./mcp-native-composite-fixture.cjs").compositeFixtureHandoffs>} Handoffs */

/** @param {Client} client @param {Parent["targets"]} pages
 * @param {import("../src/shared/mcpCompositeWorkflow").McpCompositePrepare["phases"]} phases */
async function prepareCompositeControl(client, pages, phases) {
  return client.call("prepare_composite", {
    requestId: randomUUID(),
    reason: "Native composite bounded control acceptance",
    targets: { kind: "saved", pages },
    phases,
    maxReviewPasses: 1,
    budgets: compositeNoModelBudget(phases.length, pages.length),
  });
}
/** @param {Client} client @param {Parent["targets"]} targets @param {Handoffs} handoffs */
async function cancelCompositeAtHandoff(client, targets, handoffs) {
  const parent = await prepareCompositeControl(client, targets, [
    {
      kind: "native",
      id: "cancel-images",
      action: "images-export",
      role: "work",
    },
  ]);
  const bound = await bindCompositePhase(
    client,
    parent,
    "cancel-images",
    await compositeImagesAction(client, parent),
  );
  /** @type {(id:string)=>void} */
  let resolve = () => {};
  /** @type {Promise<string>} */
  const entered = new Promise((complete) => {
    resolve = complete;
  });
  handoffs.cancelNext(resolve);
  const outputsBefore = await client.call("list_outputs", {});
  await client.call("run_composite", compositeMutation(bound));
  const finished = waitComposite(client, parent.id);
  const jobId = await Promise.race([
    entered,
    finished.then(() => {
      throw new Error(
        "Composite finished before its native cancellation boundary",
      );
    }),
  ]);
  const active = await waitCompositeChild(client, parent.id, jobId);
  assert.equal(active.used.admissions, 1);
  await client.denied("discard_composite", { id: parent.id, confirm: true });
  await client.denied("discard_retained", { id: parent.id, confirm: true });
  const cancelling = client.call("cancel_composite", compositeMutation(active));
  const [cancelled] = await Promise.all([cancelling, finished]);
  assert.equal(cancelled.status, "cancelled");
  const settled = await client.call("get_composite", { id: parent.id });
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.used.admissions, 1);
  assert.equal((await client.call("get_job", { jobId })).status, "cancelled");
  assert.equal(
    (await client.call("list_outputs", {})).total,
    outputsBefore.total,
  );
  assert.ok(settled.phases[0].attemptId);
  assert.equal(settled.phases[0].child.id, jobId);
  return settled;
}
/** Wait for the exact native checkpoint, not a different later job or fabricated delay.
 * @param {Client} client @param {string} id @param {string} jobId */
async function waitCompositeChild(client, id, jobId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const parent = await client.call("get_composite", { id });
    assert.equal(parent.status, "running");
    if (parent.phases[0].child?.id === jobId) return parent;
    await pause(10);
  }
  throw new Error("The native child identity was not checkpointed");
}
/** @param {string} root @param {Client} client @param {Parent["targets"]} targets */
async function invalidateCompositeReview(root, client, targets) {
  const parent = await prepareCompositeControl(client, targets, [
    { kind: "review", id: "stale-review" },
  ]);
  const awaiting = await runCompositePhase(client, parent);
  const review = await readCompositeReviewImages(
    client,
    awaiting,
    "stale-review",
  );
  const report = compositeHostReport(awaiting, "stale-review", review.evidence);
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const { chapterId, pageId } = targets[0];
  const before = await library.openChapter(chapterId),
    page = before.pages.find(
      (/** @type {{id:string}} */ page) => page.id === pageId,
    );
  assert.ok(page?.blocks.length);
  const oldChanges = await client.call("list_changes", {});
  await client.call("update_page_blocks", {
    chapterId,
    pageId,
    revision: createPageRevision(page),
    edits: [
      {
        blockId: page.blocks[0].id,
        fields: { translatedText: "Saved text after issued composite PNG" },
      },
    ],
  });
  const change = (await client.call("list_changes", {})).items.find(
    (/** @type {{id:string}} */ item) =>
      !oldChanges.items.some(
        (/** @type {{id:string}} */ prior) => prior.id === item.id,
      ),
  );
  assert.ok(change);
  /** @type {unknown[]} */
  const failures = [];
  try {
    const changedEvidence = review.evidence.find(
      (/** @type {{pageId:string}} */ evidence) => evidence.pageId === pageId,
    );
    assert.ok(changedEvidence);
    await client.denied("get_composite_review_image", {
      id: parent.id,
      phaseId: "stale-review",
      evidenceId: changedEvidence.id,
    });
    await client.denied("submit_composite_review", report);
    assert.equal(
      (await client.call("get_composite", { id: parent.id })).status,
      "awaiting-review",
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    const current = await client.call("get_change", { id: change.id });
    await client.call("undo_change", {
      id: change.id,
      requestId: randomUUID(),
      pages: current.pages.map(
        (
          /** @type {{chapterId:string,pageId:string,revision:string,reviewRevision:string}} */ page,
        ) => ({
          chapterId: page.chapterId,
          pageId: page.pageId,
          revision: page.revision,
          reviewRevision: page.reviewRevision,
        }),
      ),
    });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Composite stale-review assertion or native Undo failed",
      { cause: failures[0] },
    );
  const restored = await library.openChapter(chapterId);
  assert.deepEqual(
    restored.pages.map((/** @type {{blocks:unknown}} */ page) => page.blocks),
    before.pages.map((/** @type {{blocks:unknown}} */ page) => page.blocks),
  );
  return parent.id;
}
/** @param {string} root @param {import("./mcp-native-composite-client.cjs").NativeApp} app
 * @param {import("./mcp-native-composite-client.cjs").Editing} editing @param {Parent} parent */
async function denyCompositeForeignAndReadOnly(root, app, editing, parent) {
  const foreign = await compositeNativeClient(root, app, editing, {
    scope: "carrot.read offline_access",
    allowImages: false,
  });
  /** @type {unknown[]} */
  const failures = [];
  try {
    assert.equal((await foreign.call("list_composites", {})).total, 0);
    await foreign.denied("get_composite", { id: parent.id });
    await foreign.denied("reconcile_composite", compositeMutation(parent));
    await foreign.denied("discard_composite", { id: parent.id, confirm: true });
    await foreign.denied("prepare_composite", {
      ...parent.plan,
      requestId: randomUUID(),
      targets: { kind: "saved", pages: parent.targets },
      phases: [
        {
          kind: "native",
          id: "forbidden-image",
          action: "images-export",
          role: "work",
        },
      ],
    });
    const listed = await foreign.listTools();
    assert.equal(
      listed.tools.some(
        (/** @type {{name:string}} */ tool) =>
          tool.name === "carrot_get_composite_review_image",
      ),
      false,
    );
    const textParent = await prepareCompositeControl(foreign, parent.targets, [
      {
        kind: "native",
        id: "readonly-text",
        action: "text-export",
        role: "work",
      },
    ]);
    const review = await foreign.call("preflight_text_export", {
      chapterId: parent.targets[0].chapterId,
      pageIds: parent.targets.map((page) => page.pageId),
      options: { format: "txt", field: "translated", includeHeaders: true },
    });
    const text = await executeCompositePhase(
      foreign,
      textParent,
      "readonly-text",
      {
        kind: "text-export",
        input: { binding: review.binding, requestId: randomUUID() },
      },
    );
    const file = await foreign.call("get_job_file", {
      jobId: compositeChild(text, "readonly-text").id,
    });
    assert.equal(file.mimeType, "text/plain");
    assert.ok((await downloadCompositeFile(foreign, file)).length > 0);
    assert.deepEqual(foreign.errors, []);
  } catch (error) {
    failures.push(error);
  }
  try {
    await foreign.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Composite scoped-owner assertion or cleanup failed",
      { cause: failures[0] },
    );
}
module.exports = {
  prepareCompositeControl,
  cancelCompositeAtHandoff,
  invalidateCompositeReview,
  denyCompositeForeignAndReadOnly,
};
