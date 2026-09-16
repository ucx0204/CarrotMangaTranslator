const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, access } = require("node:fs/promises");
const { join, dirname } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { nativeImage } = require("electron");

/** @typedef {{type?: string, text?: string, data?: string}} Content */
/** @typedef {(name: string, args: object) => Promise<Content[]>} Invoke */
/** Only the external OCR inference boundary is synthetic. Cropping, page leases,
 * service validation, job receipts, source-field saves and raster rendering are real. */
function syntheticOcrRuntime() {
  const state = { calls: 0, releases: 0, inputs: /** @type {string[]} */ ([]) };
  return {
    state,
    runtime: {
      /** @param {import("../src/main/appSettings").TranslationOptions} options */
      collect: async (options) => {
        state.calls++;
        state.inputs.push(options.imagePath);
        const image = nativeImage.createFromBuffer(
          await readFile(options.imagePath),
        );
        assert.deepEqual(image.getSize(), { width: 130, height: 115 });
        const offset = (45 * 130 + 33) * 4;
        assert.deepEqual(
          [...image.toBitmap().subarray(offset, offset + 3)],
          [0, 0, 0],
          "OCR must use original text, not the erased raster",
        );
        assert.equal(options.skipOcrBboxHints, false);
        assert.doesNotMatch(options.outputDir, /ocr-hints/);
        return {
          hints: [
            {
              x1: 20,
              y1: 20,
              x2: 100,
              y2: 90,
              ocrText: "原文再読 ABC 🥕",
              direction: "vertical",
            },
          ],
          diagnostics: [],
        };
      },
      release: async () => {
        state.releases++;
        return true;
      },
    },
  };
}
/** @param {Content[]} value */
function metadata(value) {
  assert.equal(value.length, 1, "OCR receipts must not attach files");
  assert.ok(value[0].text);
  assert.doesNotMatch(
    JSON.stringify(value),
    /resource_link|dataUrl|mcp-artifacts/,
  );
  return JSON.parse(value[0].text);
}
/** @param {Invoke} call @param {string} jobId */
async function waitForObservation(call, jobId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const receipt = metadata(await call("carrot_get_job", { jobId }));
    if (receipt.status !== "running") {
      assert.equal(receipt.status, "completed", JSON.stringify(receipt));
      return receipt;
    }
    await delay(20);
  }
  throw new Error("Native block OCR did not finish.");
}
/** @param {Invoke} invoke @param {{chapterId: string, pageId: string}} target */
async function raster(invoke, target) {
  const content = await invoke("carrot_render_page_preview", target);
  const image = content.find((part) => part.type === "image");
  assert.ok(image?.data);
  return nativeImage
    .createFromBuffer(Buffer.from(image.data, "base64"))
    .toBitmap();
}
/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Invoke} invoke @param {string} chapterId @param {string} pageId */
async function checkNativeBlockOcr(root, app, invoke, chapterId, pageId) {
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const { McpOperationService } = require(
    join(root, "out/main/application/mcpOperationService.js"),
  );
  const { createMcpOperationTools } = require(
    join(root, "out/main/mcp/mcpOperationTools.js"),
  );
  const { createMcpBlockOcrExecutor } = require(
    join(root, "out/main/mcp/mcpBlockOcrSession.js"),
  );
  const observationRuntime = syntheticOcrRuntime();
  const operations = new McpOperationService((/** @type {unknown} */ error) =>
    console.error(error),
  );
  const tools = createMcpOperationTools(operations, {
    blockOcr: createMcpBlockOcrExecutor(app, observationRuntime.runtime),
  });
  /** @type {Invoke} */
  const call = async (name, args) => {
    const tool = tools.find(
      (/** @type {{name: string}} */ item) => item.name === name,
    );
    assert.ok(tool, name);
    return tool.invoke(args, {
      principalId: "native-block-ocr",
      assertAuthorized: () => {},
      assertScopes: (/** @type {string[]} */ scopes) =>
        assert.ok(
          scopes.every((scope) =>
            ["carrot.read", "carrot.process"].includes(scope),
          ),
        ),
    });
  };
  try {
    const before = await library.openChapter(chapterId);
    const page = before.pages[0];
    const target = { chapterId, pageId };
    const original = await readFile(page.imagePath);
    const inpainted = await readFile(page.inpaintedImagePath);
    const rendered = await raster(invoke, target);
    const request = {
      ...target,
      blockId: page.blocks[0].id,
      revision: createPageRevision(page),
      requestId: randomUUID(),
    };
    const first = metadata(await call("carrot_run_block_ocr", request));
    const job = await waitForObservation(call, first.jobId);
    assert.equal(job.result.pagesChanged, 0);
    assert.equal(
      job.result.blockOcr.previousSourceText,
      page.blocks[0].sourceText,
    );
    assert.equal(job.result.blockOcr.recognizedText, "原文再読 ABC 🥕");
    assert.equal(job.result.revision, request.revision);
    assert.deepEqual(
      await library.openChapter(chapterId),
      before,
      "Observation must not save chapter metadata or blocks",
    );
    assert.equal(
      metadata(await call("carrot_run_block_ocr", request)).jobId,
      first.jobId,
    );
    assert.equal(observationRuntime.state.calls, 1);
    assert.equal(observationRuntime.state.releases, 1);
    for (const path of observationRuntime.state.inputs)
      await assert.rejects(() => access(dirname(path)), { code: "ENOENT" });
    const edit = {
      ...target,
      revision: job.result.revision,
      edits: [
        {
          blockId: request.blockId,
          fields: { sourceText: job.result.blockOcr.recognizedText },
        },
      ],
    };
    const applied = metadata(await invoke("carrot_update_page_blocks", edit));
    const saved = (await library.openChapter(chapterId)).pages[0];
    assert.deepEqual(saved.blocks, [
      { ...page.blocks[0], sourceText: job.result.blockOcr.recognizedText },
      ...page.blocks.slice(1),
    ]);
    assert.deepEqual(await raster(invoke, target), rendered);
    await invoke("carrot_update_page_blocks", {
      ...edit,
      revision: applied.revision,
      edits: [
        {
          blockId: request.blockId,
          fields: { sourceText: job.result.blockOcr.previousSourceText },
        },
      ],
    });
    assert.deepEqual(
      (await library.openChapter(chapterId)).pages[0].blocks,
      page.blocks,
    );
    assert.deepEqual(await readFile(page.imagePath), original);
    assert.deepEqual(await readFile(page.inpaintedImagePath), inpainted);
    assert.deepEqual(await raster(invoke, target), rendered);
    assert.equal(
      observationRuntime.state.calls,
      1,
      "Apply and restoration must not rerun OCR",
    );
    assert.equal(app.jobs.gate.activities.length, 0);
    console.log(
      "PASS native block OCR: original crop after erasure, unchanged observation snapshot, one inference/release, duplicate receipt, source-only apply/restore and identical rendering",
    );
  } finally {
    await operations.close();
  }
}
module.exports = { checkNativeBlockOcr };
