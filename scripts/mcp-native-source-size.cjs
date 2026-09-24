const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

/** @typedef {(name:string,args:object)=>Promise<Array<{type?:string,text?:string}>>} Invoke */
/** @param {Invoke} invoke @param {string} name @param {object} args */
async function call(invoke, name, args) {
  const content = await invoke(name, args);
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  assert.ok(content[0].text);
  return JSON.parse(content[0].text);
}
/** @param {Invoke} invoke @param {string} jobId */
async function settle(invoke, jobId) {
  for (let i = 0; i < 200; i++) {
    const job = await call(invoke, "carrot_get_job", { jobId });
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Native source measurement did not settle");
}

/** Uses only the native harness's newly created library and source image.
 * @param {string} root @param {Invoke} invoke @param {string} sourcePath */
async function checkNativeSourceSize(root, invoke, sourcePath) {
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const imported = await library.createImport({
    preview: {
      mode: "single",
      sourceKind: "images",
      suggestedWorkTitle: "Source size fixture",
      chapters: [
        {
          draftId: "size",
          title: "Source size",
          sourceKind: "images",
          pages: [{ name: "size.png", sourcePath, sourceKind: "file" }],
        },
      ],
    },
    target: { mode: "new", title: "Source size fixture" },
    selections: [{ draftId: "size", title: "Source size", enabled: true }],
  });
  const chapterId = imported.chapterIds[0];
  const empty = (await library.openChapter(chapterId)).pages[0];
  await call(invoke, "carrot_create_page_blocks", {
    chapterId,
    pageId: empty.id,
    revision: createPageRevision(empty),
    requestId: randomUUID(),
    blocks: [
      {
        key: "size",
        sourceText: "あ",
        translatedText: "가",
        sourceRect: { x: 295, y: 495, w: 30, h: 30 },
        sourceDirection: "horizontal",
      },
    ],
  });
  const seeded = (await library.openChapter(chapterId)).pages[0];
  const blocks = structuredClone(seeded.blocks);
  delete blocks[0].fontSizeIntent;
  await library.savePageBlocks({
    chapterId,
    pageId: empty.id,
    expectedRevision: createPageRevision(seeded),
    blocks,
  });
  const before = await library.openChapter(chapterId);
  const page = before.pages[0];
  const original = await readFile(page.imagePath);
  const args = {
    chapterId,
    pageId: page.id,
    revision: createPageRevision(page),
    requestId: randomUUID(),
  };
  const receipt = await call(invoke, "carrot_run_page_source_size", args);
  const completed = await settle(invoke, receipt.jobId);
  assert.equal(completed.status, "completed", JSON.stringify(completed.error));
  assert.equal(completed.result.pagesChanged, 0);
  assert.deepEqual(completed.result.performed, ["source_size_measurement"]);
  const observation = completed.result.sourceSize;
  assert.equal(observation.measuredBlocks, 1);
  assert.equal(
    observation.sourceImageSha256,
    createHash("sha256").update(original).digest("hex"),
  );
  const { estimatePageSourceFontSizes } = require(
    join(root, "out/main/pipeline/sourceFontSizeEstimator.js"),
  );
  const { normalizeBboxTo1000 } = require(join(root, "out/shared/geometry.js"));
  const block = page.blocks[0];
  const direct = await estimatePageSourceFontSizes({
    enabled: true,
    page,
    items: [
      {
        id: 1,
        type: block.type,
        jp: block.sourceText,
        ko: block.translatedText,
        sourceText: block.sourceText,
        translatedText: block.translatedText,
        textRole: "ordinary",
        direction: block.sourceDirection,
        bbox: normalizeBboxTo1000(block.bbox, page, block.bboxSpace),
      },
    ],
  });
  assert.deepEqual(observation.items[0].estimate, direct[0]);
  assert.ok(observation.items[0].estimate.facePx >= 6);
  assert.equal(
    (await call(invoke, "carrot_run_page_source_size", args)).jobId,
    receipt.jobId,
  );
  assert.equal(JSON.stringify(completed).includes(root), false);
  assert.deepEqual(await library.openChapter(chapterId), before);
  assert.deepEqual(await readFile(page.imagePath), original);
  const stale = await call(invoke, "carrot_run_page_source_size", {
    ...args,
    revision: "page-v1:0000000000000000",
    requestId: randomUUID(),
  });
  const failed = await settle(invoke, stale.jobId);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "revision_conflict");
  assert.deepEqual(await library.openChapter(chapterId), before);
  console.log(
    "PASS native source-size measurement: real original raster matches canonical estimator, exact retry, stale revision refused, unchanged saved page and original bytes",
  );
}

module.exports = { checkNativeSourceSize };
