const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { observeExchangeWork } = require("./mcp-native-exchange-client.cjs");
const {
  outputSyncNativeClient,
  waitOutputSyncJob,
} = require("./mcp-native-output-sync-client.cjs");
const {
  reviewedOutputSyncRequest,
  cancelNativeOutputSync,
} = require("./mcp-native-output-sync-cancel.cjs");
const {
  seedOutputSyncFixture,
  createOutputSyncNativeOwner,
  outputSyncFixtureHandoffs,
  assertOutputSyncOriginals,
} = require("./mcp-native-output-sync-fixture.cjs");
const {
  readPublishedOutputSync,
  assertOutputSyncEncryption,
  assertOutputSyncDelivery,
} = require("./mcp-native-output-sync-proof.cjs");

/** @typedef {import("./mcp-native-output-sync-client.cjs").NativeApp} NativeApp */
/** @typedef {import("./mcp-native-output-sync-client.cjs").Editing} Editing */
/** @typedef {import("./mcp-native-output-sync-client.cjs").Client} Client */

/** Appended after all previous 20 native markers; real renderer, OAuth, HTTP and native writes.
 * @param {string} root @param {NativeApp} app @param {Editing} editing @param {string} sourceChapterId */
async function checkNativeOutputSync(root, app, editing, sourceChapterId) {
  assert.equal(
    app.appPaths.dataRoot,
    root,
    "Never use the live user's profile",
  );
  const fixture = await seedOutputSyncFixture(root, sourceChapterId);
  const owner = await createOutputSyncNativeOwner(root, app, fixture);
  const handoffs = outputSyncFixtureHandoffs(app, fixture);
  const observed = observeExchangeWork(app);
  /** @type {Client | undefined} */
  let client;
  let failure;
  try {
    client = await outputSyncNativeClient(
      root,
      app,
      editing,
      owner.native.reviewedOutput,
    );
    const capabilities = await client.call("get_capabilities", {});
    for (const name of [
      "get_output_destination",
      "preflight_output_sync",
      "sync_output",
      "get_output_sync",
    ])
      assert.ok(capabilities.features.includes(`carrot_${name}`));
    const cancelled = await cancelNativeOutputSync(client, owner, handoffs);
    assert.equal(
      observed.windows(),
      0,
      "Cancellation before handoff must not render",
    );
    assert.ok(
      client.errors.every(
        (error) => error instanceof Error && error.name === "AbortError",
      ),
    );
    const completed = await completeNativeOutputSync(
      root,
      client,
      fixture,
      owner,
    );
    assert.deepEqual(
      [...handoffs.acknowledged].sort(),
      [...fixture.chapter.pageOrder].sort(),
    );
    assert.ok(observed.windows() > 0, "The actual native renderer must run");
    assert.deepEqual(
      [...observed.jobs].sort(),
      [cancelled.jobId, completed.jobId].sort(),
    );
    assert.deepEqual(app.jobs.all, []);
    assert.equal(
      await readFile(join(root, "linked-sync-queue.json"), "utf8"),
      owner.queue,
    );
    await assertOutputSyncOriginals(root, fixture);
    const credentials = client.credentials;
    await client.close();
    client = await outputSyncNativeClient(
      root,
      app,
      editing,
      owner.native.reviewedOutput,
      credentials,
    );
    const windows = observed.windows();
    const jobs = [...observed.jobs];
    assert.equal(
      await owner.native.disconnect(owner.selection.connectionId),
      true,
    );
    await assertHistoricalOutputSync(client, completed, cancelled);
    assert.equal(
      observed.windows(),
      windows,
      "Historical replay must not create a renderer",
    );
    assert.deepEqual(
      [...observed.jobs],
      jobs,
      "Historical replay must not create another app job",
    );
    for (const file of completed.published)
      assert.deepEqual(await readFile(file.path), file.bytes);
    await assertOutputSyncOriginals(root, fixture);
    assert.deepEqual(client.errors, []);
    assert.deepEqual(owner.errors, []);
    console.log(
      "PASS native approved output sync -> scoped HTTP/OAuth + actual renderer/writers + encrypted receipt -> cancellation/discard guard and original-job replay after disconnect; originals preserved",
    );
  } catch (error) {
    failure = error;
  }
  handoffs.stop();
  observed.stop();
  await finishNativeOutputSync(client, owner.native, failure);
}

/** @param {string} root @param {Client} client
 * @param {import("./mcp-native-output-sync-fixture.cjs").Fixture} fixture
 * @param {Awaited<ReturnType<typeof createOutputSyncNativeOwner>>} owner */
async function completeNativeOutputSync(root, client, fixture, owner) {
  const destination = await client.call("get_output_destination", {
    chapterId: fixture.chapter.id,
  });
  assert.equal(destination.available, true);
  assert.equal(destination.connectionId, owner.selection.connectionId);
  const review = await client.call("preflight_output_sync", owner.selection);
  assert.equal(review.mirrorScope.pageCount, 2);
  assert.deepEqual(
    review.mirrorScope.chapters[0].pageIds,
    fixture.chapter.pageOrder,
  );
  assert.equal(review.executionReserved, false);
  const request = reviewedOutputSyncRequest(review);
  const accepted = await client.call("sync_output", request);
  const ended = await waitOutputSyncJob(client, accepted.jobId);
  assert.equal(ended.status, "completed", JSON.stringify(ended));
  const view = await client.call("get_output_sync", {
    requestId: request.requestId,
  });
  assert.equal(view.receipt.jobId, accepted.jobId);
  assert.equal(ended.result.outputSync.receiptId, view.receipt.id);
  assert.equal(view.receipt.status, "completed");
  assert.equal(view.receipt.publicationUnconfirmed, 0);
  assert.equal(view.receipt.metadata, "published");
  assert.equal(view.receipt.mirror, "published");
  assert.equal(view.receipt.sourceChecked, false);
  assert.equal(view.evidence.sourceChecked, false);
  assert.equal(view.evidence.destination, "matched");
  for (const id of [
    `result:${owner.selection.pageIds[0]}:publish`,
    "mirror:publish",
  ])
    assert.equal(
      view.evidence.files.find(
        (/** @type {{fileId:string}} */ file) => file.fileId === id,
      ).currentState,
      "matches_planned",
    );
  const published = await readPublishedOutputSync(
    root,
    fixture,
    owner,
    view.receipt,
  );
  await assertOutputSyncEncryption(
    root,
    client,
    view.receipt.id,
    accepted.jobId,
  );
  await assertOutputSyncDelivery(client, view.receipt.id);
  assert.equal(
    JSON.stringify({ review, accepted, ended, view }).includes(root),
    false,
  );
  return {
    request,
    jobId: accepted.jobId,
    receiptId: view.receipt.id,
    published,
  };
}

/** @param {Client} client @param {Awaited<ReturnType<typeof completeNativeOutputSync>>} completed
 * @param {Awaited<ReturnType<typeof cancelNativeOutputSync>>} cancelled */
async function assertHistoricalOutputSync(client, completed, cancelled) {
  for (const original of [completed, cancelled]) {
    const historical = await client.call("sync_output", original.request);
    assert.equal(historical.jobId, original.jobId);
    assert.equal(historical.result.outputSync.receiptId, original.receiptId);
    assert.equal(
      historical.status,
      original === completed ? "completed" : "cancelled",
    );
  }
  const view = await client.call("get_output_sync", {
    id: completed.receiptId,
  });
  assert.equal(view.receipt.status, "completed");
  assert.equal(view.receipt.historical, true);
  assert.equal(view.evidence.destination, "unavailable");
  assert.ok(
    view.evidence.files.every(
      (/** @type {{currentState:string}} */ file) =>
        file.currentState === "unavailable",
    ),
  );
  await assertOutputSyncDelivery(client, completed.receiptId);
}

/** Close physical work before disposing its sole native owner; retain both original/cleanup failures.
 * @param {Client | undefined} client @param {{dispose:()=>Promise<void>}} native @param {unknown} failure */
async function finishNativeOutputSync(client, native, failure) {
  /** @type {unknown[]} */
  const errors = failure === undefined ? [] : [failure];
  try {
    await client?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await native.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Native output sync acceptance or cleanup failed",
      { cause: errors[0] },
    );
}
module.exports = { checkNativeOutputSync };
