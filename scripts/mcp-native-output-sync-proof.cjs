const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { nativeImage } = require("electron");

/** @typedef {import("./mcp-native-output-sync-client.cjs").Client} Client */
/** @typedef {import("./mcp-native-output-sync-fixture.cjs").Fixture} Fixture */
/** @typedef {Awaited<ReturnType<typeof import("./mcp-native-output-sync-fixture.cjs").createOutputSyncNativeOwner>>} Owner */

/** Verifies the files written by the real native owner, never a second registry service.
 * @param {string} root @param {Fixture} fixture @param {Owner} owner
 * @param {import("../src/shared/mcpOutputSync").McpOutputSyncReceipt} receipt */
async function readPublishedOutputSync(root, fixture, owner, receipt) {
  const { resolvePathInside, buildLinkedMirrorFileName } = require(
    join(root, "out/main/linkedWorkspace/linkedWorkspacePaths.js"),
  );
  /** @type {import("../src/shared/linkedWorkspaceTypes").LinkedWorkspaceRegistryV1} */
  const registry = JSON.parse(
    await readFile(join(root, "linked-workspaces.json"), "utf8"),
  );
  const record = registry.records.find(
    (item) => item.id === owner.selection.connectionId,
  );
  assert.ok(record);
  const pageId = owner.selection.pageIds[0];
  const artifact = record.artifacts[pageId]?.result;
  assert.ok(artifact);
  const path = resolvePathInside(fixture.output, artifact.path);
  const result = await readFile(path);
  const raster = nativeImage.createFromBuffer(result);
  assert.deepEqual(raster.getSize(), { width: 128, height: 192 });
  assert.notDeepEqual(
    raster.toBitmap(),
    fixture.bitmap,
    "Actual native lettering must change the rendered page",
  );
  assert.deepEqual(
    raster
      .toBitmap()
      .subarray((170 * 128 + 110) * 4, (170 * 128 + 110) * 4 + 3),
    Buffer.from([0, 0, 0]),
  );
  assert.equal(
    createHash("sha256").update(result).digest("hex"),
    artifact.sha256,
  );
  assert.equal(
    receipt.files.find((file) => file.fileId === `result:${pageId}:publish`)
      ?.sha256,
    artifact.sha256,
  );
  for (const page of fixture.chapter.pages) {
    /** @type {string | undefined} */
    const relative =
      record.sourceRelativePaths?.[page.id] ??
      record.pageRelativePaths[page.id];
    assert.ok(relative);
    assert.deepEqual(
      await readFile(resolvePathInside(fixture.output, relative)),
      fixture.image,
    );
  }
  assert.equal(
    record.artifacts[fixture.chapter.pages[1].id]?.result,
    undefined,
  );
  const mirrorPath = resolvePathInside(
    fixture.output,
    buildLinkedMirrorFileName(fixture.output),
  );
  const mirrorBytes = await readFile(mirrorPath);
  const mirror = JSON.parse(mirrorBytes.toString("utf8"));
  assert.deepEqual(
    mirror.chapters.map((/** @type {{id:string}} */ chapter) => chapter.id),
    [fixture.chapter.id],
  );
  assert.deepEqual(
    mirror.chapters[0].pages.map((/** @type {{id:string}} */ page) => page.id),
    fixture.chapter.pageOrder,
  );
  assert.ok(
    mirror.chapters[0].pages.every(
      (/** @type {{blocks:{translatedText:string}[]}} */ page) =>
        page.blocks[0].translatedText === "Native sync",
    ),
  );
  assert.equal(
    receipt.files.find((file) => file.fileId === "mirror:publish")?.sha256,
    createHash("sha256").update(mirrorBytes).digest("hex"),
  );
  return [
    { path, bytes: result },
    { path: mirrorPath, bytes: mirrorBytes },
  ];
}

/** @param {string} root @param {Client} client @param {string} receiptId @param {string} jobId */
async function assertOutputSyncEncryption(root, client, receiptId, jobId) {
  const library = require(join(root, "out/main/library.js"));
  const encrypted = await readFile(
    join(library.getLibraryRoot(), ".mcp-retained", receiptId, "record.json"),
    "utf8",
  );
  assert.deepEqual(Object.keys(JSON.parse(encrypted)), ["encrypted"]);
  for (const secret of [
    root,
    receiptId,
    jobId,
    "relativePath",
    "sourceSnapshot",
  ])
    assert.equal(encrypted.includes(secret), false);
  const jobBytes = await readFile(
    join(root, "native-output-sync-journal", "mcp-private", "jobs.enc"),
    "utf8",
  );
  assert.equal(jobBytes.includes(jobId), false);
  const authorization = await readFile(
    join(root, "native-output-sync-auth", "mcp-private", "authorization.enc"),
    "utf8",
  );
  assert.equal(authorization.includes(client.credentials.accessToken), false);
  const journal = JSON.stringify(await client.journal());
  assert.equal(journal.includes(root), false);
  assert.doesNotMatch(journal, /relativePath|mcp-artifacts|"url"/);
}

/** @param {Client} client @param {string} receiptId */
async function assertOutputSyncDelivery(client, receiptId) {
  const delivery = await client.call("get_output_delivery", {
    target: { kind: "output-sync", receiptId },
  });
  assert.equal(delivery.retention.source, "not_checked");
  assert.equal(delivery.destinationPublication.receiptId, receiptId);
  assert.equal(delivery.destinationPublication.status, "completed");
  assert.doesNotMatch(
    JSON.stringify(delivery),
    /relativePath|selectionSnapshot|destinationSnapshot|sourceSnapshot|"url"|"uri"/,
  );
}
module.exports = {
  readPublishedOutputSync,
  assertOutputSyncEncryption,
  assertOutputSyncDelivery,
};
