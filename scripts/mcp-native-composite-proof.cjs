const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

/** @typedef {Awaited<ReturnType<typeof import("../src/main/library").readWorkContextForEdit>>} Context */

/** @param {string} root @param {string} chapterId @param {string} packagePath */
async function captureCompositeOriginals(root, chapterId, packagePath) {
  const library = require(join(root, "out/main/library.js"));
  const chapter = await library.openChapter(chapterId);
  const context = await captureOriginalContext(root, chapterId);
  /** @type {Map<string,Buffer|null>} */
  const files = new Map([[packagePath, await readFile(packagePath)]]);
  for (const page of chapter.pages)
    for (const path of [
      page.imagePath,
      page.inpaintedImagePath,
      page.inpaintMaskPath,
    ])
      if (path) files.set(path, await readFile(path));
  for (const [path, bytes] of context.files) files.set(path, bytes);
  return { chapter, files, context: context.value };
}
/** @param {string} root @param {Awaited<ReturnType<typeof captureCompositeOriginals>>} before */
async function assertCompositeOriginals(root, before) {
  const library = require(join(root, "out/main/library.js"));
  assert.deepEqual(
    await library.openChapter(before.chapter.id),
    before.chapter,
  );
  assert.deepEqual(
    (await captureOriginalContext(root, before.chapter.id)).value,
    before.context,
  );
  for (const [path, bytes] of before.files) {
    const after = await readOptionalOriginal(path);
    if (bytes === null)
      assert.equal(
        after,
        null,
        "An absent original context file must remain absent",
      );
    else {
      assert.ok(after);
      assert.ok(after.equals(bytes));
    }
  }
}
/** @param {string} root @param {string} chapterId */
async function captureOriginalContext(root, chapterId) {
  const library = require(join(root, "out/main/library.js"));
  const paths = require(join(root, "out/main/libraryStore/libraryPaths.js"));
  /** @type {Context} */
  const context = await library.readWorkContextForEdit(chapterId);
  const work = join(paths.getWorksRoot(), context.workId);
  const guidePath = join(work, "style-guide.json");
  const memoryPath = join(work, "chapters", chapterId, "story-memory.json");
  const guideBytes = await readOptionalOriginal(guidePath),
    memoryBytes = await readOptionalOriginal(memoryPath);
  const {
    createdAt: _created,
    updatedAt: _guideUpdated,
    ...guide
  } = context.styleGuide;
  const { updatedAt: _memoryUpdated, ...memory } = context.storyMemory;
  // Native missing-file defaults synthesize timestamps on each read. Absence is
  // separately sealed below; every persisted byte, including timestamps, is exact.
  const value = {
    ...context,
    styleGuide: guideBytes === null ? guide : context.styleGuide,
    storyMemory: memoryBytes === null ? memory : context.storyMemory,
  };
  return {
    value,
    files: new Map([
      [guidePath, guideBytes],
      [memoryPath, memoryBytes],
    ]),
  };
}
/** @param {string} path @returns {Promise<Buffer|null>} */
async function readOptionalOriginal(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
}
/** @param {string} root @param {import("./mcp-native-composite-client.cjs").Client} client
 * @param {import("./mcp-native-composite-phases.cjs").Parent} parent */
async function assertCompositeEncryption(root, client, parent) {
  const library = require(join(root, "out/main/library.js"));
  const retained = join(library.getLibraryRoot(), ".mcp-retained");
  for (const path of [
    join(retained, "index.json"),
    join(retained, parent.id, "record.json"),
  ]) {
    const content = await readFile(path, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(content)), ["encrypted"]);
    for (const secret of [
      parent.id,
      root,
      parent.plan.reason,
      "composite-workflow",
      "nativeReference",
    ])
      assert.equal(content.includes(secret), false);
  }
  const journal = await readFile(
    join(root, "native-composite-journal", "mcp-private", "jobs.enc"),
    "utf8",
  );
  for (const phase of parent.phases)
    if (phase.child?.kind === "job")
      assert.equal(journal.includes(phase.child.id), false);
  const authorization = await readFile(
    join(root, "native-composite-auth", "mcp-private", "authorization.enc"),
    "utf8",
  );
  assert.equal(authorization.includes(client.credentials.accessToken), false);
  assert.equal(authorization.includes(client.credentials.connectionId), false);
  assert.doesNotMatch(
    JSON.stringify(await client.journal()),
    /imagePath|relativePath|mcp-artifacts|"url"/,
  );
}
/** @param {string} root @param {import("./mcp-native-composite-client.cjs").Client} client
 * @param {string} requestId @param {import("./mcp-native-composite-phases.cjs").Parent} parent */
async function assertCompositeImportPublication(
  root,
  client,
  requestId,
  parent,
) {
  /** @type {import("../src/shared/mcpWorkFileImport").McpWorkFileReceipt} */
  const receipt = await client.call("get_work_file_import", { requestId });
  const mapping = receipt.pageMapping,
    proof = mapping?.publication;
  assert.ok(mapping && proof);
  assert.equal(proof.workId, receipt.workId);
  assert.deepEqual(
    proof.chapters.map((chapter) => chapter.chapterId),
    receipt.chapterIds,
  );
  const paths = require(join(root, "out/main/libraryStore/libraryPaths.js"));
  const { createSoundEffectReviewPageRevision } = require(
    join(root, "out/shared/pageRevision.js"),
  );
  const directory = join(paths.getWorksRoot(), proof.workId);
  assert.equal(
    await originalSha256(join(directory, "work.json")),
    proof.workSha256,
  );
  assert.equal(
    await originalSha256(join(directory, "style-guide.json")),
    proof.guideSha256,
  );
  for (const chapter of proof.chapters) {
    const chapterDirectory = join(directory, "chapters", chapter.chapterId);
    assert.equal(
      await originalSha256(join(chapterDirectory, "chapter.json")),
      chapter.sha256,
    );
    assert.equal(
      await originalSha256(join(chapterDirectory, "story-memory.json")),
      chapter.memorySha256,
    );
    /** @type {import("../src/shared/libraryTypes").LibraryChapter} */
    const saved = JSON.parse(
      await readFile(join(chapterDirectory, "chapter.json"), "utf8"),
    );
    /** @type {import("../src/shared/mcpImportMapping").McpImportPageMapping["items"]} */
    const items = mapping.items.filter(
      (item) => item.page.chapterId === chapter.chapterId,
    );
    assert.deepEqual(
      items.map((item) => item.page.pageId),
      saved.pages.map((page) => page.id),
    );
    assert.deepEqual(
      items.map((item) => item.page.reviewRevision),
      saved.pages.map(createSoundEffectReviewPageRevision),
    );
  }
  assert.deepEqual(
    mapping.items.map((item) => item.page.pageId),
    parent.targets.map((page) => page.pageId),
  );
  assert.doesNotMatch(
    JSON.stringify(proof),
    /imagePath|relativePath|style-guide\.json|story-memory\.json/,
  );
}
/** @param {string} path @returns {Promise<string|null>} */
async function originalSha256(path) {
  const bytes = await readOptionalOriginal(path);
  return bytes === null
    ? null
    : createHash("sha256").update(bytes).digest("hex");
}
module.exports = {
  captureCompositeOriginals,
  assertCompositeOriginals,
  assertCompositeEncryption,
  assertCompositeImportPublication,
};
