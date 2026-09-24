const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const {
  exchangeNativeClient,
  exchangeArtifactHttp,
  observeExchangeWork,
} = require("./mcp-native-exchange-client.cjs");
const {
  seedExchangeFixture,
  assertExchangeOriginals,
  exchangeFixtureHandoffs,
} = require("./mcp-native-exchange-fixture.cjs");
const {
  exportNativeTextFormats,
  exportNativeContext,
} = require("./mcp-native-exchange-export.cjs");
const {
  importNativeReviewCsv,
  recoverNativeReviewCsv,
} = require("./mcp-native-exchange-import.cjs");
const {
  importNativeContext,
  recoverNativeContext,
} = require("./mcp-native-exchange-context.cjs");
const { checkNativeDelivery } = require("./mcp-native-delivery.cjs");

/** @typedef {import("./mcp-native-exchange-client.cjs").NativeApp} NativeApp */
/** @typedef {import("./mcp-native-exchange-client.cjs").Editing} Editing */

/** Append after every prior native assertion. This creates a dedicated work in the owned profile.
 * @param {string} root @param {NativeApp} app @param {Editing} editing @param {string} sourceChapterId */
async function checkNativeExchange(root, app, editing, sourceChapterId) {
  assert.equal(app.appPaths.dataRoot, root, "Never use a real profile");
  const source = await seedExchangeFixture(root, sourceChapterId);
  const handoffs = exchangeFixtureHandoffs(root, app, source);
  const observed = observeExchangeWork(app);
  /** @type {import("./mcp-native-exchange-client.cjs").Client | undefined} */
  let client;
  /** @type {Awaited<ReturnType<typeof exchangeArtifactHttp>> | undefined} */
  let http;
  /** @type {import("./mcp-native-exchange-export.cjs").Exported[] | undefined} */
  let outputs;
  /** @type {unknown[]} */
  const failures = [];
  try {
    client = await exchangeNativeClient(root, app, editing);
    http = await exchangeArtifactHttp(root, client);
    const text = await exportNativeTextFormats(root, client, http, source);
    const context = await exportNativeContext(root, client, http, source);
    outputs = [...text, context];
    const csv = text.find((output) => output.file.mimeType === "text/csv");
    assert.ok(csv);
    const reviewed = await importNativeReviewCsv(
      root,
      client,
      http,
      source,
      csv,
    );
    assert.deepEqual(client.errors, []);
    await http.close();
    await client.close();
    client = await exchangeNativeClient(root, app, editing);
    http = await exchangeArtifactHttp(root, client);
    await recoverNativeReviewCsv(root, client, source, reviewed);
    const imported = await importNativeContext(
      root,
      client,
      http,
      source,
      context,
    );
    assert.deepEqual(client.errors, []);
    await http.close();
    await client.close();
    client = await exchangeNativeClient(root, app, editing);
    http = await exchangeArtifactHttp(root, client);
    await recoverNativeContext(root, client, source, imported);
    await assertExchangeOriginals(root, source);
    assert.equal(client.scopes.has("carrot.images"), false);
    assert.deepEqual(
      [...observed.jobKinds],
      ["mcp-edit"],
      "Text/context exchange must use native edits without a model or export job",
    );
    assert.deepEqual(
      [...handoffs.acknowledged],
      [source.context.chapter.pages[0].id],
    );
    assert.ok(handoffs.requests.size > 0, "Native edit handoffs must complete");
    assert.deepEqual(app.jobs.all, []);
    assert.deepEqual(app.jobs.pageHandoffs.activities, []);
    assert.equal(
      observed.windows(),
      0,
      "Text/context exchange must not open a renderer",
    );
    assert.deepEqual(http.errors, []);
    assert.deepEqual(client.errors, []);
    const encrypted = await readFile(
      join(root, "native-exchange-journal", "mcp-private", "jobs.enc"),
      "utf8",
    );
    const journal = JSON.stringify(await client.journal());
    for (const output of outputs) {
      assert.equal(encrypted.includes(output.jobId), false);
      assert.equal(journal.includes(output.file.url), false);
    }
    assert.equal(journal.includes(root), false);
    console.log(
      "PASS native text/context exchange -> registered UTF-8 export and CSV/context import with stale-source rejection -> OS-encrypted restart undo/redo; originals preserved",
    );
  } catch (error) {
    failures.push(error);
  }
  const cleanup = await Promise.allSettled([http?.close(), client?.close()]);
  handoffs.stop();
  observed.stop();
  const errors = [
    ...failures,
    ...cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    ),
  ];
  if (errors.length)
    throw new AggregateError(errors, "Native exchange or cleanup failed", {
      cause: errors[0],
    });
  assert.ok(outputs);
  await checkNativeDelivery(root, app, editing, source, outputs);
}
module.exports = { checkNativeExchange };
