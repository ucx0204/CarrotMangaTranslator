const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { sendNativeFile } = require("./mcp-native-incoming-files.cjs");
const {
  waitExchangeJob,
  completeExchangeResponse,
} = require("./mcp-native-exchange-client.cjs");
const {
  assertEncryptedExchangeRecord,
} = require("./mcp-native-exchange-fixture.cjs");
const { assertSafeDelivery } = require("./mcp-native-exchange-export.cjs");

/** @typedef {import("./mcp-native-exchange-client.cjs").Client} Client */
/** @typedef {import("./mcp-native-exchange-fixture.cjs").Fixture} Fixture */
/** @typedef {import("./mcp-native-exchange-export.cjs").Exported} Exported */
/** @typedef {Awaited<ReturnType<typeof importNativeReviewCsv>>} ReviewResult */

/** Upload real UTF-8 CSV through the registered chunked upload path and save selected native fields.
 * @param {string} root @param {Client} client @param {{origin:string}} http
 * @param {Fixture} source @param {Exported} exported */
async function importNativeReviewCsv(root, client, http, source, exported) {
  const library = require(join(root, "out/main/library.js"));
  const { parseReviewTable, serializeReviewRows } = require(
    join(root, "out/shared/reviewTable.js"),
  );
  const { mcpContextRevision } = require(
    join(root, "out/shared/mcpContextEditing.js"),
  );
  const { capturePageRecovery } = require(
    join(root, "out/shared/pageRecoverySnapshot.js"),
  );
  const before = await library.readWorkContextForEdit(source.chapterId);
  const page = before.chapter.pages[0];
  const rows = parseReviewTable(exported.bytes.toString("utf8"), "csv");
  const row = rows.find(
    (/** @type {import("../src/shared/reviewTable").ReviewRow} */ item) =>
      item.page_id === page.id && item.block_id === "selected",
  );
  assert.ok(row);
  Object.assign(row, {
    source_text: "명시적으로 검수한 원문",
    translated_text: ' =SUM(1,2)\r\n"검수 번역" ',
    review_status: "reviewed",
    review_note: " 보존할\t검수 메모 ",
  });
  const bytes = Buffer.from(serializeReviewRows(rows, "csv", true), "utf8");
  const uploaded = await sendNativeFile(client, bytes, "native-review.CSV");
  assert.equal(uploaded.validation, "bytes-verified");
  const plan = await client.call("preview_text_file_import", {
    source: exported.file.exchange,
    uploadId: uploaded.uploadId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contextRevision: mcpContextRevision(before),
    requestId: randomUUID(),
    reason: "Native explicit four-field CSV review",
    selection: [{ pageId: page.id, blockIds: ["selected"] }],
    updateSourceText: true,
    requireSourceMatch: false,
  });
  assert.equal(plan.totalChanges, 1);
  assert.equal(plan.application, "page-by-page");
  assert.deepEqual(await library.openChapter(source.chapterId), before.chapter);
  const preview = await client.call("get_text_file_import", {
    batchId: plan.batchId,
  });
  assert.equal(preview.changes[0].after.translatedText, row.translated_text);
  const command = {
    batchId: plan.batchId,
    requestId: randomUUID(),
    acknowledgePageByPage: true,
  };
  const accepted = await client.call("apply_text_file_import", command);
  const completed = await waitExchangeJob(client, accepted.jobId);
  assert.equal(completed.status, "completed", JSON.stringify(completed));
  const after = await library.openChapter(source.chapterId);
  assertReviewApplied(after, before.chapter, row);
  const stale = await client.call("get_output_delivery", {
    target: {
      kind: "retained-output",
      outputId: exported.file.retainedOutputId,
    },
  });
  assertSafeDelivery(stale);
  assert.equal(stale.retention.source, "stale");
  assert.equal(stale.retention.access, "blocked");
  await assert.rejects(() =>
    client.call("get_output_file", { id: exported.file.retainedOutputId }),
  );
  assert.equal(await exchangeLinkStatus(http.origin, exported.file.url), 404);
  const changes = await client.call("list_changes", {});
  assert.equal(changes.total, 1);
  const id = changes.items[0].id;
  await assertEncryptedExchangeRecord(root, id, [
    row.source_text,
    row.translated_text,
    row.review_note,
  ]);
  await client.call("discard_file_upload", { uploadId: uploaded.uploadId });
  for (const original of source.originals)
    assert.ok((await readFile(original.path)).equals(original.bytes));
  return {
    id,
    command,
    jobId: accepted.jobId,
    uploadId: uploaded.uploadId,
    before: before.chapter.pages.map(capturePageRecovery),
    after: after.pages.map(capturePageRecovery),
  };
}

/** Reconstructed native recovery never needs the discarded upload or expired preview plan.
 * @param {string} root @param {Client} client @param {Fixture} source @param {ReviewResult} record */
async function recoverNativeReviewCsv(root, client, source, record) {
  const library = require(join(root, "out/main/library.js"));
  const { capturePageRecovery } = require(
    join(root, "out/shared/pageRecoverySnapshot.js"),
  );
  await assert.rejects(() =>
    client.call("get_file_upload", { uploadId: record.uploadId }),
  );
  await assert.rejects(() =>
    client.call("get_text_file_import", { batchId: record.command.batchId }),
  );
  const replay = await client.call("apply_text_file_import", record.command);
  assert.equal(replay.jobId, record.jobId);
  assert.equal(
    (await waitExchangeJob(client, replay.jobId)).status,
    "completed",
  );
  assert.equal((await client.call("list_changes", {})).total, 1);
  for (const direction of ["undo", "redo", "undo"]) {
    assert.equal((await client.recover(record.id, direction)).status, "saved");
    const current = await library.openChapter(source.chapterId);
    assert.deepEqual(
      current.pages.map(capturePageRecovery),
      direction === "redo" ? record.after : record.before,
    );
  }
  await client.call("discard_retained", { id: record.id, confirm: true });
}

/** @param {import("../src/shared/libraryTypes").ChapterSnapshot} after
 * @param {import("../src/shared/libraryTypes").ChapterSnapshot} before
 * @param {import("../src/shared/reviewTable").ReviewRow} row */
function assertReviewApplied(after, before, row) {
  const original = before.pages[0].blocks.find(
    (block) => block.id === "selected",
  );
  const changed = after.pages[0].blocks.find(
    (block) => block.id === "selected",
  );
  assert.ok(original);
  assert.ok(changed);
  assert.deepEqual(changed, {
    ...original,
    sourceText: row.source_text,
    translatedText: row.translated_text,
    reviewStatus: row.review_status,
    reviewNote: row.review_note,
  });
  assert.deepEqual(
    after.pages[0].blocks.find((block) => block.id === "preserved"),
    before.pages[0].blocks.find((block) => block.id === "preserved"),
  );
  assert.deepEqual(after.pages[0].blockOrder, before.pages[0].blockOrder);
  assert.deepEqual(after.pages[1], before.pages[1]);
}

/** @param {string} origin @param {string} url */
async function exchangeLinkStatus(origin, url) {
  return completeExchangeResponse(origin, url, "GET", async () => {
    const response = await fetch(origin + new URL(url).pathname);
    await response.arrayBuffer();
    return response.status;
  });
}
module.exports = {
  importNativeReviewCsv,
  recoverNativeReviewCsv,
  exchangeLinkStatus,
};
