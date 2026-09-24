const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

/** Native fixture only: actual app composition, public library and export rules.
 * No real user library, image/model execution, output destination or approval changes.
 * @param {string} root @param {string} chapterId @param {string} pageId @param {number} expectedBlocks */
async function checkNativeReview(root, chapterId, pageId, expectedBlocks) {
  const library = require(join(root, "out/main/library.js"));
  const { createMcpAppTools } = require(
    join(root, "out/main/mcp/mcpAppTools.js"),
  );
  const { mcpToolResult } = require(
    join(root, "out/main/mcp/mcpToolResult.js"),
  );
  const { preflightPageImageExport } = require(
    join(root, "out/main/jobs/pageImageExportSelection.js"),
  );
  const before = await library.openChapter(chapterId);
  const page = before.pages.find(
    (/** @type {{id: string}} */ item) => item.id === pageId,
  );
  assert.ok(page);
  const original = await readFile(page.imagePath);
  const tools = createMcpAppTools({
    preferences: {
      allowImages: false,
      allowEditing: false,
      allowProcessing: false,
      autoStart: false,
    },
    assertWritable: async () => {
      throw new Error("Review must not acquire a write lease");
    },
    notifySaved: () => {
      throw new Error("Review must not save");
    },
  });
  /** @param {string} name @param {object} args */
  const call = async (name, args) => {
    const tool = tools.find(
      (/** @type {{name: string}} */ entry) => entry.name === name,
    );
    assert.ok(tool, name);
    assert.deepEqual(tool.requiredScopes, ["carrot.read"]);
    const result = mcpToolResult(
      tool,
      await tool.invoke(args, { assertAuthorized: () => {} }),
    );
    assert.equal(result.isError, false);
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(JSON.stringify(result).includes(page.imagePath), false);
    assert.equal(
      result.content.every(
        (/** @type {{type: string}} */ item) => item.type === "text",
      ),
      true,
    );
    assert.deepEqual(
      JSON.parse(result.content[0].text),
      result.structuredContent,
    );
    return result.structuredContent;
  };
  const review = await call("carrot_get_chapter_review", { chapterId });
  assert.equal(review.scope, "saved-metadata-only");
  assert.equal(review.summary.pages, 1);
  assert.equal(review.pages[0].counts.blocks, expectedBlocks);
  const filtered = await call("carrot_get_chapter_review", {
    chapterId,
    filter: "no-blocks",
  });
  assert.equal(filtered.total, expectedBlocks === 0 ? 1 : 0);
  const tail = await call("carrot_get_chapter_review", {
    chapterId,
    offset: 1,
    snapshot: review.snapshot,
  });
  assert.deepEqual(tail.pages, []);
  const preflight = await call("carrot_preflight_page_export", {
    chapterId,
    pageId,
  });
  const desktop = await preflightPageImageExport(
    {
      workId: before.workId,
      outputFormat: "png",
      omitText: false,
      selections: [{ chapterId, mode: "page-set", pageIds: [pageId] }],
    },
    library,
  );
  assert.deepEqual(
    preflight.issues,
    desktop.issues.map(
      (/** @type {{code: string, severity: string}} */ issue) => ({
        code: issue.code,
        severity: issue.severity,
      }),
    ),
  );
  assert.equal(preflight.executionReserved, false);
  assert.ok(preflight.notChecked.includes("translation-quality"));
  assert.ok(
    preflight.notChecked.includes("image-transfer-permission-and-redaction"),
  );
  assert.deepEqual(await library.openChapter(chapterId), before);
  assert.deepEqual(await readFile(page.imagePath), original);
  console.log(
    `PASS native read-only chapter review and app PNG preflight (${expectedBlocks} blocks); saved data and source unchanged`,
  );
}
module.exports = { checkNativeReview };
