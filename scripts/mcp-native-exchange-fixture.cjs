const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

/** @typedef {typeof import("../src/main/library")} Library */
/** @typedef {Awaited<ReturnType<typeof seedExchangeFixture>>} Fixture */

/** Dedicated imported work after the original native checks, never their selected pages.
 * @param {string} root @param {string} sourceChapterId */
async function seedExchangeFixture(root, sourceChapterId) {
  const library = require(join(root, "out/main/library.js"));
  const { getAppPaths } = require(join(root, "out/main/appPaths.js"));
  assert.equal(getAppPaths().dataRoot, root);
  const source = await library.openChapter(sourceChapterId);
  const image = await readFile(source.pages[0].imagePath);
  const draftId = randomUUID();
  const imported = await library.createImport({
    preview: {
      mode: "batch",
      sourceKind: "images",
      suggestedWorkTitle: "Native exchange fixture",
      chapters: [
        {
          draftId,
          title: "Native exchange chapter",
          sourceKind: "images",
          pages: ["exchange-one.png", "exchange-two.png"].map((name) => ({
            name,
            sourcePath: source.pages[0].imagePath,
            sourceKind: "file",
          })),
        },
      ],
    },
    target: { mode: "new", title: "Native exchange fixture" },
    selections: [{ draftId, title: "Native exchange chapter", enabled: true }],
  });
  const chapterId = imported.chapterIds[0];
  const importedChapter = await library.openChapter(chapterId);
  for (const page of importedChapter.pages) {
    await library.savePageBlocks({
      chapterId,
      pageId: page.id,
      blocks: [
        exchangeBlock("selected", 0, page),
        exchangeBlock("preserved", 1, page),
      ],
      blockOrder: ["preserved", "selected"],
    });
    assert.ok((await readFile(page.imagePath)).equals(image));
  }
  await seedGuideAndMemory(library, chapterId);
  const context = await library.readWorkContextForEdit(chapterId);
  const originals = await Promise.all(
    context.chapter.pages.map(
      async (
        /** @type {import("../src/shared/libraryTypes").MangaPage} */ page,
      ) => ({
        path: page.imagePath,
        bytes: await readFile(page.imagePath),
      }),
    ),
  );
  const workRoot = join(
    library.getLibraryRoot(),
    "works",
    context.chapter.workId,
  );
  const contextFiles = {
    guide: await readFile(join(workRoot, "style-guide.json")),
    memory: await readFile(
      join(workRoot, "chapters", chapterId, "story-memory.json"),
    ),
  };
  assert.deepEqual(await library.openChapter(sourceChapterId), source);
  assert.ok((await readFile(source.pages[0].imagePath)).equals(image));
  return {
    chapterId,
    workId: context.chapter.workId,
    context,
    originals,
    contextFiles,
  };
}

/** @param {string} id @param {number} position
 * @param {Pick<import("../src/shared/libraryTypes").MangaPage, "width" | "height">} page
 * @returns {import("../src/shared/textTypes").TranslationBlock} */
function exchangeBlock(id, position, page) {
  return {
    id,
    type: "nonsolid",
    bbox: {
      x: page.width * (0.05 + position * 0.5),
      y: page.height * 0.05,
      w: page.width * 0.4,
      h: page.height * 0.9,
    },
    sourceText: `원문 ${id}, "quotation"`,
    translatedText: `기존 번역 ${id}`,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: Math.max(1, Math.min(12, page.width / 8)),
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#000000",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

/** @param {Library} library @param {string} chapterId */
async function seedGuideAndMemory(library, chapterId) {
  const chapter = await library.openChapter(chapterId);
  const guide = await library.getWorkStyleGuide(chapter.workId);
  const stamp = new Date().toISOString();
  guide.glossary = [
    {
      id: "exchange-term",
      source: "용어",
      target: "Original term",
      category: "term",
      enabled: true,
      origin: "manual",
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
  await library.saveWorkStyleGuide(guide);
  const memory = await library.getChapterStoryMemory(chapterId);
  memory.pages = [
    {
      pageId: chapter.pages[0].id,
      pageName: chapter.pages[0].name,
      pageIndex: 0,
      summary: "Original native memory",
      sourceDigest: "original source evidence",
      translatedDigest: "original translation evidence",
      updatedAt: stamp,
    },
  ];
  await library.saveChapterStoryMemory(memory);
}

/** @param {string} root @param {Fixture} source */
async function assertExchangeOriginals(root, source) {
  const library = require(join(root, "out/main/library.js"));
  const { capturePageRecovery } = require(
    join(root, "out/shared/pageRecoverySnapshot.js"),
  );
  const current = await library.openChapter(source.chapterId);
  assert.deepEqual(
    current.pages.map(capturePageRecovery),
    source.context.chapter.pages.map(capturePageRecovery),
  );
  for (const original of source.originals)
    assert.ok((await readFile(original.path)).equals(original.bytes));
}

/** @param {string} root @param {string} id @param {string[]} secrets */
async function assertEncryptedExchangeRecord(root, id, secrets) {
  const library = require(join(root, "out/main/library.js"));
  const bytes = await readFile(
    join(library.getLibraryRoot(), ".mcp-retained", id, "record.json"),
    "utf8",
  );
  assert.deepEqual(Object.keys(JSON.parse(bytes)), ["encrypted"]);
  for (const secret of secrets) assert.equal(bytes.includes(secret), false);
}
/** Only the newly imported fixture has no renderer edits to flush. Native page
 * acquisition still re-reads the saved chapter and enforces its own edit guards.
 * @param {string} root
 * @param {import("./mcp-native-exchange-client.cjs").NativeApp} app
 * @param {Fixture} source */
function exchangeFixtureHandoffs(root, app, source) {
  assert.equal(app.appPaths.dataRoot, root, "Never acknowledge a real profile");
  assert.equal(app.getMainWindow(), null, "The fixture must have no editor");
  const pageIds = new Set(
    source.context.chapter.pages.map(
      (/** @type {import("../src/shared/libraryTypes").MangaPage} */ page) =>
        page.id,
    ),
  );
  /** @type {Set<string>} */
  const acknowledged = new Set();
  /** @type {Set<string>} */
  const requests = new Set();
  const handoffs = app.jobs.pageHandoffs;
  const stop = handoffs.subscribe(() => {
    for (const page of handoffs.activities) {
      const job = app.jobs.get(page.jobId);
      if (
        page.chapterId !== source.chapterId ||
        !pageIds.has(page.pageId) ||
        page.phase !== "finishing-edits" ||
        !page.requestId ||
        requests.has(page.requestId) ||
        job?.kind !== "mcp-edit" ||
        job.abortController.signal.aborted ||
        app.getMainWindow() !== null
      )
        continue;
      if (handoffs.respond({ requestId: page.requestId })) {
        requests.add(page.requestId);
        acknowledged.add(page.pageId);
      }
    }
  });
  return { acknowledged, requests, stop };
}

module.exports = {
  seedExchangeFixture,
  assertExchangeOriginals,
  assertEncryptedExchangeRecord,
  exchangeFixtureHandoffs,
};
