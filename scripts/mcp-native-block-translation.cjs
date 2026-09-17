const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { nativeImage } = require("electron");

/** @typedef {{text?: string, type?: string, data?: string}} Content */
/** @typedef {(name: string, args: object) => Promise<Content[]>} Invoke */
/** @typedef {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} App */
/** @param {string} root @param {string} path */
function load(root, path) {
  return require(join(root, "out", path));
}
/** @param {Content[]} content */
function metadata(content) {
  assert.equal(content.length, 1, "Proposals must not attach files or images");
  assert.ok(content[0].text);
  assert.doesNotMatch(JSON.stringify(content), /resource_link|mcp-artifacts|imagePath|apiKey/);
  return JSON.parse(content[0].text);
}
/** @param {Invoke} call @param {string} jobId */
async function completedProposal(call, jobId) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const receipt = metadata(await call("carrot_get_job", { jobId }));
    if (receipt.status !== "running") {
      assert.equal(receipt.status, "completed", JSON.stringify(receipt));
      assert.equal(receipt.result.pagesChanged, 0);
      assert.equal(receipt.result.status, "proposed");
      return receipt.result;
    }
    await delay(20);
  }
  throw new Error("Native block translation did not settle");
}
/** @param {Invoke} invoke @param {{chapterId: string, pageId: string}} target */
async function renderedBitmap(invoke, target) {
  const content = await invoke("carrot_render_page_preview", target);
  const part = content.find((item) => item.type === "image");
  assert.ok(part?.data);
  return nativeImage.createFromBuffer(Buffer.from(part.data, "base64")).toBitmap();
}
/** Only model transport is synthetic. Context selection, prompts, reply parsing,
 * page ownership, job history, save transactions and raster rendering are real.
 * @param {string} root @param {App} app */
function createProposalFixture(root, app) {
  const { McpOperationService } = load(root, "main/application/mcpOperationService.js");
  const { createMcpOperationTools } = load(root, "main/mcp/mcpOperationTools.js");
  const { createMcpBlockTranslationExecutor } = load(root, "main/mcp/mcpBlockTranslationSession.js");
  const { readMcpBlockTranslationContext } = load(root, "main/mcp/mcpBlockTranslationContext.js");
  const state = { calls: 0, releases: 0, starts: 0, source: "" };
  /** @type {NonNullable<Parameters<import("../src/main/mcp/mcpBlockTranslationAdapter").translateMcpBlock>[3]>} */
  const runtime = {
    start: async () => {
      state.starts++;
      return {
        handle: { provider: "openai-api", child: null, startedByScript: false, baseUrl: "https://synthetic.invalid" },
        dispose: async () => { state.releases++; },
      };
    },
    request: async ({ options, systemPrompt, userPrompt }) => {
      state.calls++;
      assert.equal(options.imagePath, "");
      assert.equal(options.textOnlyModel, true);
      assert.equal(options.autoFontMatching, false);
      assert.equal(options.apiKeyMaxAttempts, 1);
      assert.match(systemPrompt, /untrusted data/);
      const input = JSON.parse(userPrompt);
      assert.equal(input.sourceText, state.source);
      assert.doesNotMatch(userPrompt, /image_url|imagePath|keep source/);
      return JSON.stringify({ blockId: input.blockId, translatedText: "New native translation" });
    },
    readContext: readMcpBlockTranslationContext,
  };
  const operations = new McpOperationService((/** @type {unknown} */ error) => console.error(error));
  const tools = createMcpOperationTools(operations, {
    blockTranslation: createMcpBlockTranslationExecutor(app, runtime),
  });
  /** @type {Invoke} */
  const call = async (name, args) => {
    const tool = tools.find((/** @type {{name: string}} */ item) => item.name === name);
    assert.ok(tool, name);
    return tool.invoke(args, {
      principalId: "native-block-translation",
      assertAuthorized: () => {},
      assertScopes: (/** @type {string[]} */ scopes) => assert.ok(scopes.every((scope) => ["carrot.read", "carrot.process"].includes(scope))),
    });
  };
  return { state, call, close: () => operations.close() };
}
/** @param {string} root @param {App} app @param {Invoke} invoke
 * @param {string} chapterId @param {string} pageId */
async function checkNativeBlockTranslation(root, app, invoke, chapterId, pageId) {
  const library = load(root, "main/library.js");
  const { createPageRevision } = load(root, "shared/pageRevision.js");
  const before = await library.openChapter(chapterId);
  const page = before.pages.find((/** @type {{id: string}} */ item) => item.id === pageId);
  assert.ok(page);
  const original = await readFile(page.imagePath);
  const erased = await readFile(page.inpaintedImagePath);
  const target = { chapterId, pageId };
  const bitmap = await renderedBitmap(invoke, target);
  const fixture = createProposalFixture(root, app);
  fixture.state.source = page.blocks[0].sourceText;
  try {
    const request = { ...target, blockId: page.blocks[0].id, revision: createPageRevision(page), requestId: randomUUID(), contextMode: "saved" };
    const started = metadata(await fixture.call("carrot_run_block_translation", request));
    const result = await completedProposal(fixture.call, started.jobId);
    assert.equal(result.revision, request.revision);
    assert.equal(result.blockTranslation.sourceText, page.blocks[0].sourceText);
    assert.equal(result.blockTranslation.previousTranslatedText, page.blocks[0].translatedText);
    assert.equal(result.blockTranslation.requestCount, 1);
    assert.deepEqual(await library.openChapter(chapterId), before, "Proposal generation must not write the library");
    assert.deepEqual(await renderedBitmap(invoke, target), bitmap);
    assert.equal(metadata(await fixture.call("carrot_run_block_translation", request)).jobId, started.jobId);
    assert.equal(fixture.state.calls, 1);
    assert.equal(fixture.state.starts, 1);
    assert.equal(fixture.state.releases, 1);
    await applyAndRestore(root, invoke, target, page, result, bitmap);
    assert.deepEqual(await readFile(page.imagePath), original);
    assert.deepEqual(await readFile(page.inpaintedImagePath), erased);
    assert.equal(fixture.state.calls, 1, "Explicit application/restoration must not generate again");
    assert.equal(app.jobs.gate.activities.length, 0);
    console.log("PASS native text-only block proposal: unchanged snapshot, one request/release, duplicate receipt, translation-only apply/restore, raster change and restoration, intact source/erasure images");
  } finally {
    await fixture.close();
  }
}
/** @param {string} root @param {Invoke} invoke
 * @param {{chapterId: string, pageId: string}} target
 * @param {import("../src/shared/libraryTypes").PageRecord} page
 * @param {{revision: string, blockTranslation: {translatedText: string, previousTranslatedText: string}}} result
 * @param {Buffer} beforeBitmap */
async function applyAndRestore(root, invoke, target, page, result, beforeBitmap) {
  const library = load(root, "main/library.js");
  const request = { ...target, revision: result.revision, edits: [{ blockId: page.blocks[0].id, translatedText: result.blockTranslation.translatedText }] };
  const applied = metadata(await invoke("carrot_update_translations", request));
  const saved = (await library.openChapter(target.chapterId)).pages.find((/** @type {{id: string}} */ item) => item.id === target.pageId);
  assert.deepEqual(saved.blocks, [{ ...page.blocks[0], translatedText: result.blockTranslation.translatedText }, ...page.blocks.slice(1)]);
  assert.notDeepEqual(await renderedBitmap(invoke, target), beforeBitmap, "The renderer must display the new translated text");
  const restored = metadata(await invoke("carrot_update_translations", { ...request, revision: applied.revision, edits: [{ blockId: page.blocks[0].id, translatedText: result.blockTranslation.previousTranslatedText }] }));
  assert.equal(restored.status, "saved");
  const after = (await library.openChapter(target.chapterId)).pages.find((/** @type {{id: string}} */ item) => item.id === target.pageId);
  assert.deepEqual(after.blocks, page.blocks);
  assert.deepEqual(after.blockOrder, page.blockOrder);
  assert.deepEqual(await renderedBitmap(invoke, target), beforeBitmap);
}
module.exports = { checkNativeBlockTranslation };
