const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { waitOutputSyncJob } = require("./mcp-native-output-sync-client.cjs");

/** @typedef {import("./mcp-native-output-sync-client.cjs").Client} Client */
/** @typedef {Awaited<ReturnType<typeof import("./mcp-native-output-sync-fixture.cjs").createOutputSyncNativeOwner>>} Owner */
/** @typedef {ReturnType<typeof import("./mcp-native-output-sync-fixture.cjs").outputSyncFixtureHandoffs>} Handoffs */

/** @param {import("../src/shared/mcpOutputSync").McpOutputSyncPreflight} review
 * @returns {import("../src/shared/mcpOutputSync").McpSyncOutput} */
function reviewedOutputSyncRequest(review) {
  return {
    chapterId: review.chapterId,
    connectionId: review.connectionId,
    pageIds: review.pageIds,
    selectionSnapshot: review.selectionSnapshot,
    destinationSnapshot: review.destinationSnapshot,
    sourceSnapshot: review.sourceSnapshot,
    requestId: randomUUID(),
    confirm: true,
    acknowledgePartialPublication: true,
    acknowledgeSavedTextMirror: true,
  };
}

/** Cancels through actual HTTP after native handoff entry and verifies active generic discard denial.
 * @param {Client} client @param {Owner} owner @param {Handoffs} handoffs */
async function cancelNativeOutputSync(client, owner, handoffs) {
  const review = await client.call("preflight_output_sync", owner.selection);
  const request = reviewedOutputSyncRequest(review);
  /** @type {(id:string)=>void} */
  let resolve = () => {};
  /** @type {Promise<string>} */
  const entered = new Promise((complete) => {
    resolve = complete;
  });
  handoffs.cancelNext(resolve);
  const started = await client.call("sync_output", request);
  const completion = waitOutputSyncJob(client, started.jobId);
  const observed = await Promise.race([
    entered,
    completion.then(() => {
      throw new Error("Native sync ended before its cancellation handoff");
    }),
  ]);
  assert.equal(observed, started.jobId);
  const active = await client.call("get_output_sync", {
    requestId: request.requestId,
  });
  assert.equal(active.receipt.status, "running");
  await assert.rejects(() =>
    client.call("discard_retained", { id: active.receipt.id, confirm: true }),
  );
  assert.equal(
    (await client.call("get_output_sync", { id: active.receipt.id })).receipt
      .status,
    "running",
  );
  await client.call("cancel_job", { jobId: started.jobId });
  const ended = await completion;
  assert.equal(ended.status, "cancelled", JSON.stringify(ended));
  assert.equal(ended.result.status, "cancelled");
  const view = await client.call("get_output_sync", { id: active.receipt.id });
  assert.equal(view.receipt.status, "cancelled");
  assert.equal(view.receipt.publishedBytes, 0);
  assert.equal(view.receipt.publicationUnconfirmed, 0);
  assert.ok(
    view.receipt.files.every(
      (/** @type {{state:string}} */ file) => file.state === "planned",
    ),
  );
  assert.deepEqual(view.evidence.files, []);
  return { request, jobId: started.jobId, receiptId: view.receipt.id };
}
module.exports = { reviewedOutputSyncRequest, cancelNativeOutputSync };
