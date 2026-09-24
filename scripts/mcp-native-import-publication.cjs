const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { retainedClient } = require("./mcp-native-retention.cjs");
const {
  checkNativeLibraryOrganization,
} = require("./mcp-native-library-organization.cjs");

/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** Only the external web collection is replaced. Native image validation, publication,
 * OS encryption, tool composition and restart execute the real application code.
 * @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {{assertWritable:()=>Promise<void>,assertClean:()=>Promise<void>,notifySaved:()=>void}} editing
 * @param {string} source */
async function checkNativeImportPublication(root, app, editing, source) {
  assert.equal(app.appPaths.dataRoot, root, "Use only the smoke-owned profile");
  const library = require(join(root, "out/main/library.js"));
  const { WebImportSessionManager } = require(
    join(root, "out/main/webImportSessionManager.js"),
  );
  const prototype = WebImportSessionManager.prototype;
  const scan = prototype.scan;
  const prepare = prototype.prepareImport;
  let scans = 0;
  prototype.scan = async () => {
    scans++;
    return syntheticCollection();
  };
  prototype.prepareImport = async () => ({
    preview: {
      mode: "single",
      sourceKind: "images",
      suggestedWorkTitle: "Native group",
      chapters: [
        {
          draftId: randomUUID(),
          title: "Collected input",
          sourceKind: "images",
          pages: [
            {
              name: "collected.png",
              sourcePath: source,
              sourceKind: "file",
              storageStem: "1",
            },
          ],
        },
      ],
    },
  });
  /** @type {Client | undefined} */
  let client;
  try {
    client = await retainedClient(root, app, editing);
    const before = await library.listLibrary();
    const bytes = await readFile(source);
    const input = await preparePublication(client);
    assert.deepEqual(await library.listLibrary(), before);
    const result = await waitPublication(
      client,
      await client.call("import_batch_chapters", input),
    );
    const receipt = result.importReceipt;
    assert.ok(receipt);
    assert.equal(receipt.chapterIds.length, 2);
    assert.deepEqual(
      receipt.batch.items.map(
        (/** @type {{itemId:string}} */ item) => item.itemId,
      ),
      input.items.map((item) => item.itemId),
    );
    for (const id of receipt.chapterIds) {
      const chapter = await library.openChapter(id);
      assert.equal(chapter.pages.length, 1);
      assert.deepEqual(await readFile(chapter.pages[0].imagePath), bytes);
    }
    const encrypted = await readFile(
      join(
        library.getLibraryRoot(),
        ".mcp-retained",
        receipt.id,
        "record.json",
      ),
      "utf8",
    );
    assert.doesNotMatch(
      encrypted,
      /Native grouped publication|Collected input|collected\.png/,
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    const replay = await waitPublication(
      client,
      await client.call("import_batch_chapters", input),
    );
    assert.deepEqual(replay.importReceipt, receipt);
    await client.call("discard_retained", { id: receipt.id, confirm: true });
    await client.close();
    client = await retainedClient(root, app, editing);
    const restored = await client.call("get_import_batch", { id: input.id });
    assert.equal(restored.status, "completed");
    assert.ok(
      restored.items.every(
        (/** @type {{status:string}} */ item) => item.status === "imported",
      ),
    );
    assert.equal(
      (await library.listLibrary()).works.length,
      before.works.length + 1,
    );
    assert.equal(scans, 2);
    assert.deepEqual(await readFile(source), bytes);
    console.log(
      "PASS native grouped publication -> real image validation -> atomic OS-encrypted receipt and plan -> restart replay -> receipt disposal preserves imported state",
    );
    await client.close();
    client = undefined;
    await checkNativeLibraryOrganization(
      root,
      app,
      editing,
      receipt.workId,
      receipt.chapterIds,
    );
    assert.equal(scans, 2, "Organization must not collect web sources again");
    assert.deepEqual(await readFile(source), bytes);
  } finally {
    prototype.scan = scan;
    prototype.prepareImport = prepare;
    await client?.close();
  }
}
function syntheticCollection() {
  return {
    status: "ready",
    result: {
      sessionId: randomUUID(),
      pageTitle: "Collected input",
      sourceHost: "example.com",
      candidates: [
        {
          id: randomUUID(),
          previewUrl: "fixture-not-transferred",
          width: 12,
          height: 16,
          pixelCount: 192,
          byteSize: 100,
          format: "png",
          storedExtension: ".png",
          pageIndex: 0,
        },
      ],
      skipped: { unsupported: 0, failed: 0, duplicate: 0, blocked: 0 },
      truncated: false,
    },
  };
}
/** @param {Client} client */
async function preparePublication(client) {
  const plan = await client.call("prepare_import_batch", {
    requestId: randomUUID(),
    sources: [1, 2].map((index) => ({
      kind: "url",
      url: `https://example.com/native/${index}`,
      label: `Native chapter ${index}`,
    })),
  });
  await waitPublication(
    client,
    await client.call("run_import_batch", {
      id: plan.id,
      version: plan.version,
      requestId: randomUUID(),
      allowNetwork: true,
    }),
  );
  const ready = await client.call("get_import_batch", { id: plan.id });
  const items = [];
  for (const item of ready.items) {
    const preview = item.preview;
    const review = await client.call("get_import_preview", {
      previewId: preview.previewId,
      snapshot: preview.snapshot,
    });
    const page = review.pages[0];
    items.push({
      itemId: item.id,
      previewId: preview.previewId,
      snapshot: preview.snapshot,
      chapters: [
        { draftId: page.draftId, title: item.label, pageIds: [page.pageId] },
      ],
    });
  }
  return {
    id: ready.id,
    version: ready.version,
    requestId: randomUUID(),
    allowNativePreparation: true,
    target: { mode: "new", title: "Native grouped publication" },
    items: items.reverse(),
  };
}
/** @param {Client} client @param {{jobId:string}} accepted */
async function waitPublication(client, accepted) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await client.call("get_job", { jobId: accepted.jobId });
    if (job.status === "completed") return job.result;
    assert.equal(job.status, "running", JSON.stringify(job));
    await pause(15);
  }
  throw new Error("Native grouped publication did not settle");
}
module.exports = { checkNativeImportPublication };
