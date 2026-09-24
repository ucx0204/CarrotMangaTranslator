const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const AdmZip = require("adm-zip");
const {
  executeCompositePhase,
  compositeChild,
} = require("./mcp-native-composite-phases.cjs");
const { downloadCompositeFile } = require("./mcp-native-composite-client.cjs");
const {
  assertNativeWorkFileArchive,
} = require("./mcp-native-work-file-archive.cjs");

/** @typedef {import("./mcp-native-composite-client.cjs").Client} Client */
/** @typedef {import("./mcp-native-composite-phases.cjs").Parent} Parent */

/** @param {Client} client @param {Parent} parent */
async function exportCompositeText(client, parent) {
  const chapterId = parent.targets[0].chapterId;
  const review = await client.call("preflight_text_export", {
    chapterId,
    pageIds: parent.targets.map((page) => page.pageId),
    options: { format: "txt", field: "translated", includeHeaders: true },
  });
  const settled = await executeCompositePhase(client, parent, "text", {
    kind: "text-export",
    input: { binding: review.binding, requestId: randomUUID() },
  });
  const child = compositeChild(settled, "text");
  assert.equal(child.kind, "job");
  const file = await client.call("get_job_file", { jobId: child.id });
  assert.equal(file.mimeType, "text/plain");
  assert.ok(file.retainedOutputId);
  const bytes = await downloadCompositeFile(client, file);
  assert.equal(bytes.length, review.bytes);
  assert.ok(bytes.length > 0);
  assert.equal(bytes.toString("utf8").includes("\uFFFD"), false);
  return settled;
}
/** @param {Client} client @param {Parent} parent */
async function compositeImagesAction(client, parent) {
  const chapterId = parent.targets[0].chapterId;
  const review = await client.call("preflight_pages_export", {
    chapterId,
    pageIds: parent.targets.map((page) => page.pageId),
    imageExport: { format: "png", omitText: false },
  });
  /** @type {import("../src/shared/mcpCompositeWorkflowActions").McpCompositeWorkflowAction} */
  const action = {
    kind: "images-export",
    input: {
      chapterId,
      snapshot: review.snapshot,
      requestId: randomUUID(),
      pages: review.pages.map(
        (/** @type {{pageId:string,revision:string}} */ page) => ({
          pageId: page.pageId,
          revision: page.revision,
        }),
      ),
      imageExport: { format: "png", omitText: false },
    },
  };
  return action;
}
/** @param {Client} client @param {Parent} parent */
async function exportCompositeImages(client, parent) {
  const settled = await executeCompositePhase(
    client,
    parent,
    "images",
    await compositeImagesAction(client, parent),
  );
  const child = compositeChild(settled, "images");
  assert.equal(child.kind, "job");
  const job = await client.call("get_job", { jobId: child.id });
  assert.equal(job.status, "completed");
  assert.equal(job.result.exportPages.completed, parent.targets.length);
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (const page of job.result.exportPages.pages) {
    assert.equal(page.status, "exported");
    assert.ok(page.retainedOutputId);
    const file = await client.call("get_job_file", {
      jobId: child.id,
      pageId: page.pageId,
    });
    assert.equal(file.retainedOutputId, page.retainedOutputId);
    files.set(page.filename, await downloadCompositeFile(client, file));
  }
  return { parent: settled, child, files };
}
/** The caller reconstructs the session first; no render is required to assemble exact retained pages.
 * @param {Client} client @param {Parent} parent @param {Awaited<ReturnType<typeof exportCompositeImages>>} images */
async function exportCompositeZip(client, parent, images) {
  const settled = await executeCompositePhase(client, parent, "zip", {
    kind: "zip-export",
    input: {
      sourceJobId: images.child.id,
      requestId: randomUUID(),
      allowPartial: false,
    },
  });
  const child = compositeChild(settled, "zip");
  assert.equal(child.kind, "job");
  const file = await client.call("get_job_file", { jobId: child.id });
  assert.equal(file.mimeType, "application/zip");
  assert.ok(file.retainedOutputId);
  const bytes = await downloadCompositeFile(client, file);
  const entries = new AdmZip(bytes).getEntries();
  assert.deepEqual(
    entries.map((entry) => entry.entryName),
    [...images.files.keys(), "manifest.json"],
  );
  for (const entry of entries) {
    if (entry.entryName === "manifest.json")
      assert.doesNotMatch(
        entry.getData().toString(),
        /imagePath|mcp-artifacts|sourceText|translatedText/,
      );
    else {
      const expected = images.files.get(entry.entryName);
      assert.ok(expected);
      assert.ok(entry.getData().equals(expected));
    }
  }
  return { parent: settled, file, bytes };
}
/** @param {string} root @param {Client} client @param {Parent} parent */
async function exportCompositeWorkingFile(root, client, parent) {
  const workId = parent.targets[0].workId,
    chapterIds = [...new Set(parent.targets.map((page) => page.chapterId))];
  const review = await client.call("preflight_work_file_export", {
    workId,
    chapterIds,
  });
  const source = await captureCompositeArchive(root, parent);
  const settled = await executeCompositePhase(client, parent, "working-file", {
    kind: "work-file-export",
    input: {
      workId,
      chapterIds: review.chapterIds,
      snapshot: review.snapshot,
      sourceSnapshot: review.sourceSnapshot,
      requestId: randomUUID(),
      acknowledgeOriginalImages: true,
      acknowledgeV1Limitations: true,
    },
  });
  const child = compositeChild(settled, "working-file");
  assert.equal(child.kind, "job");
  const file = await client.call("get_job_file", { jobId: child.id });
  assert.equal(file.mimeType, "application/vnd.carrot.mgtshare");
  assertNativeWorkFileArchive(
    await downloadCompositeFile(client, file),
    source,
  );
  for (const [path, bytes] of source.files)
    assert.ok((await readFile(path)).equals(bytes));
  return settled;
}
/** Snapshot this new work without changing guide defaults or upstream fixture data.
 * @param {string} root @param {Parent} parent */
async function captureCompositeArchive(root, parent) {
  /** @type {typeof import("../src/main/library")} */
  const library = require(join(root, "out/main/library.js"));
  const directory = join(
    library.getLibraryRoot(),
    "works",
    parent.targets[0].workId,
  );
  /** @type {Map<string,Buffer>} */
  const files = new Map();
  const workPath = join(directory, "work.json"),
    guidePath = join(directory, "style-guide.json");
  const workBytes = await readFile(workPath);
  files.set(workPath, workBytes);
  files.set(guidePath, await readFile(guidePath));
  /** @type {import("../src/shared/libraryTypes").LibraryWork} */
  const work = JSON.parse(workBytes.toString());
  const guide = await library.getWorkStyleGuide(work.id);
  /** @type {import("../src/shared/libraryTypes").LibraryChapter[]} */
  const chapters = [];
  for (const id of work.chapterOrder) {
    const path = join(directory, "chapters", id, "chapter.json"),
      bytes = await readFile(path);
    files.set(path, bytes);
    /** @type {import("../src/shared/libraryTypes").LibraryChapter} */
    const chapter = JSON.parse(bytes.toString());
    chapters.push(chapter);
    for (const page of chapter.pages)
      for (const path of [
        page.imagePath,
        page.inpaintedImagePath,
        page.inpaintMaskPath,
      ])
        if (path) files.set(path, await readFile(path));
  }
  const chapter = await library.openChapter(parent.targets[0].chapterId);
  return { chapter, chapters, work, guide, files };
}
module.exports = {
  exportCompositeText,
  compositeImagesAction,
  exportCompositeImages,
  exportCompositeZip,
  exportCompositeWorkingFile,
};
