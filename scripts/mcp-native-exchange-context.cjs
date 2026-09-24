const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { sendNativeFile } = require("./mcp-native-incoming-files.cjs");
const {
  assertEncryptedExchangeRecord,
} = require("./mcp-native-exchange-fixture.cjs");
const { assertSafeDelivery } = require("./mcp-native-exchange-export.cjs");
const { exchangeLinkStatus } = require("./mcp-native-exchange-import.cjs");

/** @typedef {import("./mcp-native-exchange-client.cjs").Client} Client */
/** @typedef {import("./mcp-native-exchange-fixture.cjs").Fixture} Fixture */
/** @typedef {import("./mcp-native-exchange-export.cjs").Exported} Exported */
/** @typedef {Awaited<ReturnType<typeof importNativeContext>>} ContextResult */

/** Exact exported JSON, explicit native glossary/memory targets, no replacement or model inference.
 * @param {string} root @param {Client} client @param {{origin:string}} http
 * @param {Fixture} source @param {Exported} exported */
async function importNativeContext(root, client, http, source, exported) {
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const {
    decodeMcpContextExchangePayload,
    encodeMcpContextExchangePayload,
  } = require(join(root, "out/shared/mcpContextExchangePayload.js"));
  const { payload } = decodeMcpContextExchangePayload(exported.bytes);
  assert.ok(payload.guide);
  assert.ok(payload.memory);
  const page = (await library.openChapter(source.chapterId)).pages[0];
  const chapterBefore = await library.openChapter(source.chapterId);
  const before = {
    guide: await library.getWorkStyleGuide(source.workId),
    memory: await library.getChapterStoryMemory(source.chapterId),
  };
  payload.guide.glossary[0].target = "명시적으로 가져온 용어";
  payload.guide.glossary[0].origin = "ai";
  payload.memory.pages[0].summary = "명시적으로 가져온 문맥 요약";
  payload.memory.pages[0].sourceDigest =
    "Uploaded evidence is not authoritative";
  payload.memory.pages[0].translatedDigest =
    "Uploaded translation evidence is not authoritative";
  const bytes = Buffer.from(encodeMcpContextExchangePayload(payload));
  const uploaded = await sendNativeFile(client, bytes, "native-context.JSON");
  const selections = [
    {
      changeId: "glossary-target",
      entity: "glossary",
      entryId: "exchange-term",
      fields: ["target"],
    },
    {
      changeId: "memory-summary",
      entity: "memory",
      pageId: page.id,
      pageRevision: createPageRevision(page),
      fields: ["summary"],
    },
  ];
  const intent = {
    chapterId: source.chapterId,
    uploadId: uploaded.uploadId,
    requestId: randomUUID(),
    selections,
  };
  const review = await client.call("preview_context_import", intent);
  assert.equal(review.totalChanges, 2);
  assert.equal(review.retention, "requires-live-upload-until-apply");
  assert.deepEqual(await library.openChapter(source.chapterId), chapterBefore);
  assert.deepEqual(
    await library.getWorkStyleGuide(source.workId),
    before.guide,
  );
  const command = {
    ...intent,
    sourceSha256: review.sourceSha256,
    referenceSnapshot: review.referenceSnapshot,
    planFingerprint: review.planFingerprint,
    selectedChangeIds: ["glossary-target", "memory-summary"],
  };
  const fresh = await client.call("get_output_file", {
    id: exported.file.retainedOutputId,
  });
  const result = await client.call("apply_context_import", command);
  assert.equal(result.status, "saved");
  assert.deepEqual(result.changes, {
    guideChanged: true,
    pages: 0,
    blocks: 0,
    memories: 1,
  });
  const after = {
    guide: await library.getWorkStyleGuide(source.workId),
    memory: await library.getChapterStoryMemory(source.chapterId),
  };
  assert.equal(
    after.guide.glossary[0].target,
    payload.guide.glossary[0].target,
  );
  assert.equal(after.guide.glossary[0].origin, before.guide.glossary[0].origin);
  assert.equal(after.memory.pages[0].summary, payload.memory.pages[0].summary);
  assert.equal(
    after.memory.pages[0].sourceDigest,
    before.memory.pages[0].sourceDigest,
  );
  assert.equal(
    after.memory.pages[0].translatedDigest,
    before.memory.pages[0].translatedDigest,
  );
  assert.deepEqual(await library.openChapter(source.chapterId), chapterBefore);
  const stale = await client.call("get_output_delivery", {
    target: {
      kind: "retained-output",
      outputId: exported.file.retainedOutputId,
    },
  });
  assertSafeDelivery(stale);
  assert.equal(stale.retention.source, "stale");
  assert.equal(stale.retention.access, "blocked");
  assert.equal(await exchangeLinkStatus(http.origin, fresh.url), 404);
  await assert.rejects(() =>
    client.call("get_output_file", { id: exported.file.retainedOutputId }),
  );
  await assertEncryptedExchangeRecord(root, result.id, [
    payload.guide.glossary[0].target,
    payload.memory.pages[0].summary,
  ]);
  await client.call("discard_file_upload", { uploadId: uploaded.uploadId });
  return {
    id: result.id,
    command,
    uploadId: uploaded.uploadId,
    before,
    after,
    chapterBefore,
  };
}

/** @param {string} root @param {Client} client @param {Fixture} source @param {ContextResult} record */
async function recoverNativeContext(root, client, source, record) {
  const library = require(join(root, "out/main/library.js"));
  await assert.rejects(() =>
    client.call("get_file_upload", { uploadId: record.uploadId }),
  );
  const replay = await client.call("apply_context_import", record.command);
  assert.equal(replay.id, record.id);
  assert.equal(replay.status, "already_applied");
  assert.equal(replay.historical, true);
  for (const direction of ["undo", "redo", "undo"]) {
    const state = await client.call("get_context_migration", { id: record.id });
    assert.equal(direction === "undo" ? state.canUndo : state.canRedo, true);
    const result = await client.call(`${direction}_context_migration`, {
      id: record.id,
      requestId: randomUUID(),
      referenceSnapshot: state.referenceSnapshot,
    });
    assert.equal(result.status, "saved");
    const expected = direction === "redo" ? record.after : record.before;
    assert.deepEqual(
      await library.getWorkStyleGuide(source.workId),
      expected.guide,
    );
    assert.deepEqual(
      await library.getChapterStoryMemory(source.chapterId),
      expected.memory,
    );
    assert.deepEqual(
      await library.openChapter(source.chapterId),
      record.chapterBefore,
    );
  }
  await client.call("discard_retained", { id: record.id, confirm: true });
}
module.exports = { importNativeContext, recoverNativeContext };
