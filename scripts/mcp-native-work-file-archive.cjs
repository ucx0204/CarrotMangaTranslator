const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const AdmZip = require("adm-zip");

/** @typedef {typeof import("../src/main/library")} Library */
/** @typedef {import("../src/shared/libraryTypes").LibraryChapter} Chapter */
/** @typedef {import("../src/shared/libraryTypes").LibraryPageRecord} Page */

/** Set up meaningful native guide data before recording the preservation baseline.
 * @param {Library} library @param {string} chapterId */
async function captureWorkFileFixture(library, chapterId) {
  const chapter = await library.openChapter(chapterId);
  assert.ok(
    chapter.pages[0].inpaintedImagePath,
    "Run the raster fixture first",
  );
  const previous = await library.getWorkStyleGuide(chapter.workId);
  const stamp = new Date().toISOString();
  const guide = await library.saveWorkStyleGuide({
    ...previous,
    glossary: [
      {
        id: "native-export-term",
        source: "Native source",
        target: "Editable translation",
        category: "term",
        enabled: true,
        origin: "manual",
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    rules: { ...previous.rules, honorifics: "preserve" },
  });
  const directory = join(library.getLibraryRoot(), "works", chapter.workId);
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  const workBytes = await readFile(join(directory, "work.json"));
  files.set(join(directory, "work.json"), workBytes);
  files.set(
    join(directory, "style-guide.json"),
    await readFile(join(directory, "style-guide.json")),
  );
  /** @type {import("../src/shared/libraryTypes").LibraryWork} */
  const work = JSON.parse(workBytes.toString());
  /** @type {Chapter[]} */
  const chapters = [];
  for (const id of work.chapterOrder) {
    const path = join(directory, "chapters", id, "chapter.json");
    const bytes = await readFile(path);
    files.set(path, bytes);
    /** @type {Chapter} */
    const saved = JSON.parse(bytes.toString());
    chapters.push(saved);
    for (const page of saved.pages) {
      files.set(page.imagePath, await readFile(page.imagePath));
      if (page.inpaintedImagePath)
        files.set(
          page.inpaintedImagePath,
          await readFile(page.inpaintedImagePath),
        );
    }
  }
  assert.equal(
    chapters.length,
    2,
    "The original incoming append supplies the second chapter",
  );
  return { chapter, chapters, work, guide, files };
}

/** @param {Buffer} bytes @param {Awaited<ReturnType<typeof captureWorkFileFixture>>} source */
function assertNativeWorkFileArchive(bytes, source) {
  const entries = new AdmZip(bytes).getEntries();
  /** @type {Map<string, Buffer>} */
  const files = new Map(
    entries.map((entry) => [entry.entryName, entry.getData()]),
  );
  assert.equal(files.size, entries.length, "No duplicate archive entries");
  const manifest = JSON.parse(requiredFile(files, "manifest.json").toString());
  assert.equal(manifest.format, "manga-gemma-translator-share");
  assert.equal(manifest.version, 1);
  assert.ok(Number.isFinite(Date.parse(manifest.exportedAt)));
  assert.deepEqual(manifest.work, {
    id: source.work.id,
    title: source.work.title,
  });
  assert.deepEqual(manifest.chapterOrder, source.work.chapterOrder);
  assert.deepEqual(
    JSON.parse(requiredFile(files, "style-guide.json").toString()),
    source.guide,
  );
  const expectedPaths = ["manifest.json", "style-guide.json"];
  for (const chapter of source.chapters) {
    const path = "chapters/" + chapter.id + "/chapter.json";
    expectedPaths.push(path);
    /** @type {Chapter} */
    const shared = JSON.parse(requiredFile(files, path).toString());
    assert.deepEqual({ ...shared, pages: [] }, { ...chapter, pages: [] });
    assert.deepEqual(
      shared.pages.map((page) => page.id),
      chapter.pageOrder,
    );
    for (const page of shared.pages) {
      const original = chapter.pages.find((item) => item.id === page.id);
      assert.ok(original);
      assertSharedPage(page, original, files, source.files, expectedPaths);
    }
  }
  assert.deepEqual([...files.keys()].sort(), expectedPaths.sort());
}

/** @param {Page} shared @param {Page} original
 * @param {Map<string, Buffer>} files @param {Map<string, Buffer>} sourceFiles
 * @param {string[]} expectedPaths */
function assertSharedPage(shared, original, files, sourceFiles, expectedPaths) {
  assert.deepEqual(editableMetadata(shared), editableMetadata(original));
  for (const key of [
    "inpaintMaskPath",
    "maskProvenance",
    "translationCheckpoint",
    "fontContinuity",
  ])
    assert.equal(Object.hasOwn(shared, key), false);
  expectedPaths.push(shared.imagePath);
  assert.ok(
    requiredFile(files, shared.imagePath).equals(
      requiredFile(sourceFiles, original.imagePath),
    ),
    "Shared original image bytes must match",
  );
  if (original.inpaintedImagePath) {
    assert.ok(shared.inpaintedImagePath);
    expectedPaths.push(shared.inpaintedImagePath);
    assert.ok(
      requiredFile(files, shared.inpaintedImagePath).equals(
        requiredFile(sourceFiles, original.inpaintedImagePath),
      ),
      "Shared processed image bytes must match",
    );
  } else assert.equal(shared.inpaintedImagePath, undefined);
}

/** @param {Page} page */
function editableMetadata({
  imagePath: _imagePath,
  inpaintedImagePath: _inpaintedImagePath,
  inpaintMaskPath: _inpaintMaskPath,
  maskProvenance: _maskProvenance,
  translationCheckpoint: _translationCheckpoint,
  fontContinuity: _fontContinuity,
  ...page
}) {
  return page;
}

/** @param {Map<string, Buffer>} files @param {string} path */
function requiredFile(files, path) {
  const bytes = files.get(path);
  assert.ok(bytes, path);
  return bytes;
}

/** @param {Library} library @param {Awaited<ReturnType<typeof captureWorkFileFixture>>} source */
async function assertWorkFileFixtureUnchanged(library, source) {
  for (const [path, bytes] of source.files)
    assert.ok((await readFile(path)).equals(bytes), path);
  assert.deepEqual(
    await library.openChapter(source.chapter.id),
    source.chapter,
  );
}

/** @param {Library} library @param {string} workId
 * @param {Awaited<ReturnType<typeof captureWorkFileFixture>>} source */
async function assertImportedWorkFileGuide(library, workId, source) {
  const guide = await library.getWorkStyleGuide(workId);
  assert.equal(guide.workId, workId);
  assert.notEqual(workId, source.work.id);
  assert.deepEqual(guide.glossary, source.guide.glossary);
  assert.deepEqual(guide.characters, source.guide.characters);
  assert.deepEqual(guide.rules, source.guide.rules);
}

module.exports = {
  captureWorkFileFixture,
  assertNativeWorkFileArchive,
  assertWorkFileFixtureUnchanged,
  assertImportedWorkFileGuide,
};
