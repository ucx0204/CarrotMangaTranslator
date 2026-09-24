const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { app: electronApp } = require("electron");
const { retainedClient, waitOutput } = require("./mcp-native-retention.cjs");
const { download } = require("./mcp-native-export-batch.cjs");
const { importEditableWorkFile } = require("./mcp-native-work-file-import.cjs");
const {
  captureWorkFileFixture,
  assertNativeWorkFileArchive,
  assertWorkFileFixtureUnchanged,
  assertImportedWorkFileGuide,
} = require("./mcp-native-work-file-archive.cjs");

/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** @typedef {Parameters<typeof retainedClient>[1]} NativeApp */
/** @typedef {Parameters<typeof retainedClient>[2]} Editing */
/** @typedef {Awaited<ReturnType<typeof captureWorkFileFixture>>} Source */
/** @typedef {Parameters<typeof importEditableWorkFile>[4]} Wait */

/** The caller passes main()'s owned mkdtemp dataRoot, containing copied out/main code.
 * Its copied appPaths module resolves that same directory as the native data root.
 * Uses registered public tools, the native writer and the production HTTP server.
 * @param {string} root @param {NativeApp} app @param {Editing} editing
 * @param {string} chapterId @param {Wait} wait */
async function checkNativeWorkFileExport(root, app, editing, chapterId, wait) {
  assert.equal(
    root,
    app.appPaths.dataRoot,
    "Use only the isolated fixture profile",
  );
  const library = require(join(root, "out/main/library.js"));
  const source = await captureWorkFileFixture(library, chapterId);
  const output = await exportAndImport(root, app, editing, source, wait);
  await reissueAndDiscard(root, app, editing, output);
  await assertWorkFileFixtureUnchanged(library, source);
  console.log(
    "PASS native work-file output -> registered export and editable roundtrip -> HTTP native bytes and reconstructed retained reissue -> discard revocation and original preservation",
  );
}

/** @param {string} root @param {NativeApp} app @param {Editing} editing
 * @param {Source} source @param {Wait} wait */
async function exportAndImport(root, app, editing, source, wait) {
  const client = await retainedClient(root, app, editing);
  /** @type {Awaited<ReturnType<typeof artifactHttp>> | undefined} */
  let http;
  try {
    http = await artifactHttp(root, client);
    const file = await exportPublicWorkFile(client, app, source);
    await assertHead(http.origin, file);
    const bytes = await download(http.origin, file);
    assertNativeWorkFileArchive(bytes, source);
    const library = require(join(root, "out/main/library.js"));
    const imported = await importEditableWorkFile(
      client,
      library,
      bytes,
      source.chapter,
      wait,
    );
    await assertImportedWorkFileGuide(library, imported.receipt.workId, source);
    await client.call("discard_retained", {
      id: imported.receipt.id,
      confirm: true,
    });
    await assertWorkFileFixtureUnchanged(library, source);
    assert.deepEqual(http.errors, []);
    return { file, bytes };
  } finally {
    await http?.close();
    await client.close();
  }
}

/** @param {Client} client @param {NativeApp} app @param {Source} source */
async function exportPublicWorkFile(client, app, source) {
  const observed = observeNativeOutputWork(app);
  try {
    const review = await client.call("preflight_work_file_export", {
      workId: source.work.id,
      chapterIds: [...source.work.chapterOrder].reverse(),
    });
    assert.doesNotMatch(
      JSON.stringify(review),
      /mcp-artifacts|resource_link|"url"/,
    );
    assert.equal(review.executionReserved, false);
    assert.equal(review.includesStyleGuide, true);
    assert.equal(review.chapterCount, 2);
    assert.equal(review.pageCount, 2);
    assert.equal(review.blockCount, 4);
    assert.equal(review.workTitle, source.work.title);
    assert.deepEqual(review.chapterIds, source.work.chapterOrder);
    assert.deepEqual(
      review.chapters.map(
        (/** @type {{title: string}} */ chapter) => chapter.title,
      ),
      source.chapters.map((chapter) => chapter.title),
    );
    assert.equal(
      observed.jobs.size,
      0,
      "Preflight must not start a native job",
    );
    const command = {
      workId: review.workId,
      chapterIds: review.chapterIds,
      snapshot: review.snapshot,
      sourceSnapshot: review.sourceSnapshot,
      requestId: randomUUID(),
      acknowledgeOriginalImages: true,
      acknowledgeV1Limitations: true,
    };
    const accepted = await client.call("export_work_file", command);
    const result = await waitOutput(client, accepted.jobId);
    assert.equal(result.kind, "native-work-file");
    assert.deepEqual(result.performed, ["package", "export"]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /mcp-artifacts|resource_link|"url"/,
    );
    assert.equal(result.workFileExport.format, "mgtshare-v1");
    assert.equal(result.workFileExport.snapshot, review.snapshot);
    assert.equal(result.workFileExport.sourceSnapshot, review.sourceSnapshot);
    assert.ok(result.retainedOutputId);
    assert.equal(
      (await client.call("export_work_file", command)).jobId,
      accepted.jobId,
    );
    const file = await client.call("get_job_file", { jobId: accepted.jobId });
    assert.equal(file.kind, "native-work-file");
    assert.equal(file.filename, "carrot-work.mgtshare");
    assert.equal(file.mimeType, "application/vnd.carrot.mgtshare");
    assert.equal(file.retainedOutputId, result.retainedOutputId);
    assert.deepEqual(file.workFileExport, result.workFileExport);
    assert.equal(
      observed.jobs.size,
      1,
      "One native export, no duplicate serialization",
    );
    assert.equal(
      observed.windows(),
      0,
      "Editable archive output must not open a renderer",
    );
    return file;
  } finally {
    observed.stop();
  }
}

/** @param {string} root @param {NativeApp} app @param {Editing} editing
 * @param {Awaited<ReturnType<typeof exportAndImport>>} output */
async function reissueAndDiscard(root, app, editing, output) {
  const observed = observeNativeOutputWork(app);
  /** @type {Client | undefined} */
  let client;
  /** @type {Awaited<ReturnType<typeof artifactHttp>> | undefined} */
  let http;
  try {
    client = await retainedClient(root, app, editing);
    http = await artifactHttp(root, client);
    assert.equal((await client.call("list_jobs", {})).total, 0);
    assert.equal(await linkStatus(http.origin, output.file.url), 404);
    const file = await client.call("get_output_file", {
      id: output.file.retainedOutputId,
    });
    assert.notEqual(file.url, output.file.url);
    assert.equal(file.mimeType, output.file.mimeType);
    assert.equal(file.sha256, output.file.sha256);
    await assertHead(http.origin, file);
    // Compare the entire native archive, including its original exportedAt timestamp.
    assert.ok(
      (await download(http.origin, file)).equals(output.bytes),
      "Reissued native archive bytes must match the retained original",
    );
    assert.equal((await client.call("list_jobs", {})).total, 0);
    assert.equal(
      observed.jobs.size,
      0,
      "Retained reissue must not serialize or render",
    );
    assert.equal(observed.windows(), 0, "Reissue must not open a renderer");
    await client.call("discard_retained", {
      id: output.file.retainedOutputId,
      confirm: true,
    });
    assert.equal(await linkStatus(http.origin, file.url), 404);
    assert.deepEqual(http.errors, []);
  } finally {
    observed.stop();
    await http?.close();
    await client?.close();
  }
}

/** @param {string} root @param {Client} client */
async function artifactHttp(root, client) {
  const { startMcpHttpServer } = require(
    join(root, "out/main/mcp/mcpHttpServer.js"),
  );
  /** @type {unknown[]} */
  const errors = [];
  const http = await startMcpHttpServer({
    config: { port: 0, token: randomUUID().repeat(2) },
    tools: [],
    artifacts: client.artifacts,
    reportError: (/** @type {unknown} */ error) => errors.push(error),
  });
  return { origin: new URL(http.url).origin, close: http.close, errors };
}

/** @param {string} origin @param {{url: string, mimeType: string, bytes: number}} file */
async function assertHead(origin, file) {
  const response = await fetch(origin + new URL(file.url).pathname, {
    method: "HEAD",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), file.mimeType);
  assert.equal(response.headers.get("content-length"), String(file.bytes));
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="carrot-work.mgtshare"',
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await response.text(), "");
}

/** @param {string} origin @param {string} url */
async function linkStatus(origin, url) {
  const response = await fetch(origin + new URL(url).pathname);
  await response.arrayBuffer();
  return response.status;
}

/** Observe real app activity and Electron windows without replacing the writer or renderer.
 * @param {NativeApp} app */
function observeNativeOutputWork(app) {
  /** @type {Set<string>} */
  const jobs = new Set();
  let windows = 0;
  const windowCreated = () => {
    windows++;
  };
  const unsubscribe = app.jobs.gate.subscribe(() => {
    for (const activity of app.jobs.gate.activities)
      if (activity.category === "job") jobs.add(activity.id);
  });
  electronApp.on("browser-window-created", windowCreated);
  return {
    jobs,
    windows: () => windows,
    stop: () => {
      unsubscribe();
      electronApp.off("browser-window-created", windowCreated);
    },
  };
}

module.exports = { checkNativeWorkFileExport };
