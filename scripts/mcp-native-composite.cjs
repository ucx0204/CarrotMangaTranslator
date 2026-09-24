const assert = require("node:assert/strict");
const { join } = require("node:path");
const { observeExchangeWork } = require("./mcp-native-exchange-client.cjs");
const { compositeNativeClient } = require("./mcp-native-composite-client.cjs");
const {
  assertCompositeRegistration,
} = require("./mcp-native-composite-phases.cjs");
const {
  prepareCompositeImport,
  importCompositePages,
  compositeFixtureHandoffs,
  applyCompositeContext,
} = require("./mcp-native-composite-fixture.cjs");
const {
  exportCompositeText,
  exportCompositeImages,
  exportCompositeZip,
  exportCompositeWorkingFile,
} = require("./mcp-native-composite-outputs.cjs");
const { reviewCompositePages } = require("./mcp-native-composite-review.cjs");
const {
  restartCompositeClient,
  reissueCompositeZip,
  requireCompositeRebindAfterRestart,
} = require("./mcp-native-composite-restart.cjs");
const {
  cancelCompositeAtHandoff,
  invalidateCompositeReview,
  denyCompositeForeignAndReadOnly,
} = require("./mcp-native-composite-controls.cjs");
const {
  captureCompositeOriginals,
  assertCompositeOriginals,
  assertCompositeEncryption,
} = require("./mcp-native-composite-proof.cjs");

/** @typedef {import("./mcp-native-composite-client.cjs").NativeApp} NativeApp */
/** @typedef {import("./mcp-native-composite-client.cjs").Editing} Editing */
/** @typedef {import("./mcp-native-composite-restart.cjs").Live} Live */
/** @typedef {import("./mcp-native-composite-phases.cjs").Parent} Parent */
/** @typedef {ReturnType<typeof observeExchangeWork>} Observation */

/** The caller passes main()'s owned mkdtemp dataRoot with its copied out/main code.
 * New helper only: the root-owned harness appends this after its prior 21 markers.
 * Real Electron/native storage/render/import only; no models or production substitutes.
 * @param {string} root @param {NativeApp} app @param {Editing} editing
 * @param {string} packagePath @param {string} sourceChapterId */
async function checkNativeComposite(
  root,
  app,
  editing,
  packagePath,
  sourceChapterId,
) {
  assert.equal(app.appPaths.dataRoot, root, "Never use a real profile");
  const before = await captureCompositeOriginals(
    root,
    sourceChapterId,
    packagePath,
  );
  const observed = observeExchangeWork(app);
  /** @type {Live | undefined} */
  let live;
  /** @type {ReturnType<typeof compositeFixtureHandoffs> | undefined} */
  let handoffs;
  /** @type {unknown[]} */
  const failures = [];
  try {
    live = { client: await compositeNativeClient(root, app, editing) };
    await assertCompositeRegistration(live.client);
    const prepared = await prepareCompositeImport(
      root,
      live.client,
      packagePath,
    );
    const imported = await importCompositePages(root, live.client, prepared);
    handoffs = compositeFixtureHandoffs(app, imported.chapter.id);
    const completed = await completeNativeComposite(
      root,
      app,
      editing,
      live,
      imported.parent,
      observed,
    );
    await requireCompositeRebindAfterRestart(
      root,
      app,
      editing,
      live,
      completed.targets,
      observed,
    );
    await cancelCompositeAtHandoff(live.client, completed.targets, handoffs);
    await invalidateCompositeReview(root, live.client, completed.targets);
    assert.deepEqual(live.client.errors, []);
    await live.client.close();
    await denyCompositeForeignAndReadOnly(root, app, editing, completed);
    await assertCompositeOriginals(root, before);
  } catch (error) {
    failures.push(error);
  }
  if (live) {
    try {
      await live.client.close();
    } catch (error) {
      failures.push(error);
    }
  }
  handoffs?.stop();
  observed.stop();
  if (failures.length)
    throw new AggregateError(
      failures,
      "Native composite acceptance or cleanup failed",
      { cause: failures[0] },
    );
  console.log(
    "PASS native composite reviewed import -> selected context and text -> actual review PNG and host report -> native outputs -> exact retained ZIP reconstruction; no automatic restart or models",
  );
  console.log(
    "PASS native composite scoped ownership -> explicit rebind after restart -> physical cancellation cleanup -> saved-source review invalidation; original data preserved",
  );
}
/** @param {string} root @param {NativeApp} app @param {Editing} editing @param {Live} live
 * @param {Parent} imported @param {Observation} observed */
async function completeNativeComposite(
  root,
  app,
  editing,
  live,
  imported,
  observed,
) {
  const library = require(join(root, "out/main/library.js"));
  let parent = await applyCompositeContext(root, live.client, imported);
  parent = await exportCompositeText(live.client, parent);
  const beforeReview = await library.openChapter(parent.targets[0].chapterId);
  parent = (await reviewCompositePages(live.client, parent, "review")).parent;
  assert.deepEqual(
    await library.openChapter(parent.targets[0].chapterId),
    beforeReview,
    "Host reporting cannot edit saved review status or page state",
  );
  const images = await exportCompositeImages(live.client, parent);
  parent = images.parent;
  await restartCompositeClient(root, app, editing, live, observed);
  const reconstructed = await live.client.call("get_composite", {
    id: parent.id,
  });
  assert.deepEqual(reconstructed.phases, parent.phases);
  assert.equal(reconstructed.automaticResume, false);
  const windows = observed.windows(),
    jobs = observed.jobs.size;
  const zip = await exportCompositeZip(live.client, reconstructed, images);
  assert.equal(
    observed.windows(),
    windows,
    "ZIP reconstruction cannot create a renderer",
  );
  assert.equal(
    observed.jobs.size,
    jobs,
    "ZIP reconstruction cannot rerun native page jobs",
  );
  parent = await exportCompositeWorkingFile(root, live.client, zip.parent);
  assert.equal(parent.status, "completed");
  assert.equal(parent.completedPhases, 7);
  assert.equal(parent.used.admissions, 7);
  assert.ok(parent.used.pageAttempts <= 14);
  assert.ok(Object.values(parent.used.models).every((value) => value === 0));
  await assertCompositeEncryption(root, live.client, parent);
  await restartCompositeClient(root, app, editing, live, observed);
  await reissueCompositeZip(live.client, parent, zip, observed);
  return parent;
}
module.exports = { checkNativeComposite };
