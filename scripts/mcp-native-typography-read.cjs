const assert = require("node:assert/strict");
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

/** Uses the already isolated native fixture, not the user's library.
 * @param {string} root @param {Invoke} invoke
 * @param {string} chapterId @param {string} pageId */
async function checkNativeTypographyRead(root, invoke, chapterId, pageId) {
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const before = await library.openChapter(chapterId);
  const page = before.pages.find(
    (/** @type {{id:string}} */ value) => value.id === pageId,
  );
  assert.ok(page);
  const original = await readFile(page.imagePath);
  const fonts = await call(invoke, "carrot_list_fonts", { limit: 100 });
  assert.ok(fonts.total > 0);
  assert.ok(
    fonts.fonts.some(
      (/** @type {{availability:string}} */ value) =>
        value.availability === "available",
    ),
  );
  assert.equal(
    /fontPath|fileName|dataUrl|unicodeRanges/.test(JSON.stringify(fonts)),
    false,
  );
  const repeated = await call(invoke, "carrot_list_fonts", {
    limit: 100,
    snapshot: fonts.snapshot,
  });
  assert.equal(repeated.snapshot, fonts.snapshot);
  const args = {
    chapterId,
    pageIds: [pageId],
    mode: "size",
    sourceLanguage: "ja",
    targetLanguage: "ko",
  };
  const size = await call(invoke, "carrot_preflight_typography", args);
  assert.equal(size.executionReserved, false);
  assert.equal(size.analysisToolAvailable, false);
  assert.equal(size.requiresOcr, false);
  assert.equal(size.pages.length, 1);
  assert.equal(size.pages[0].revision, createPageRevision(page));
  assert.equal(size.counts.blocks, page.blocks.length);
  assert.equal(size.counts.fontEligible, 0);
  assert.equal(
    /sourceText|translatedText|imagePath|dataUrl/.test(JSON.stringify(size)),
    false,
  );
  const font = await call(invoke, "carrot_preflight_typography", {
    ...args,
    mode: "font",
  });
  assert.equal(font.status, "blocked");
  if (font.counts.fontEligible > 0) {
    assert.equal(font.requiresOcr, true);
    assert.ok(
      font.blockers.includes("font_analysis_requires_explicit_ocr_permission"),
    );
  } else {
    assert.ok(font.blockers.includes("no_eligible_blocks"));
  }
  await assert.rejects(() =>
    invoke("carrot_list_fonts", { path: "not-a-public-argument" }),
  );
  await assert.rejects(() =>
    invoke("carrot_preflight_typography", {
      ...args,
      pageIds: [pageId, pageId],
    }),
  );
  const after = await library.openChapter(chapterId);
  assert.deepEqual(after, before);
  assert.deepEqual(await readFile(page.imagePath), original);
  console.log(
    "PASS native font registry + typography read preflight; no model, page or image changes",
  );
}

module.exports = { checkNativeTypographyRead };
