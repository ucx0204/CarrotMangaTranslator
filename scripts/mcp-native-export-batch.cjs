const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { nativeImage } = require("electron");
const AdmZip = require("adm-zip");
/** @typedef {(name: string, args: object) => Promise<Array<{type?: string, text?: string, uri?: string}>>} Invoke */
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
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await call(invoke, "carrot_get_job", { jobId });
    assert.doesNotMatch(
      JSON.stringify(result),
      /mcp-artifacts|resource_link|"url"/,
    );
    if (result.status !== "running") {
      assert.equal(result.status, "completed", JSON.stringify(result));
      return result;
    }
    await delay(30);
  }
  throw new Error("Native batch output did not complete");
}
/** @param {string} origin @param {{url: string, mimeType: string, bytes: number, sha256: string}} file */
async function download(origin, file) {
  const response = await fetch(origin + new URL(file.url).pathname);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), file.mimeType);
  assert.equal(response.headers.get("content-length"), String(file.bytes));
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  return bytes;
}
/** @param {Invoke} invoke @param {string} chapterId @param {string} jobId
 * @param {Array<{pageId: string, revision: string, filename: string, width: number, height: number}>} pages
 * @param {string} origin */
async function comparePages(invoke, chapterId, jobId, pages, origin) {
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (const page of pages) {
    const file = await call(invoke, "carrot_get_job_file", {
      jobId,
      pageId: page.pageId,
    });
    const bytes = await download(origin, file);
    const rendered = nativeImage.createFromBuffer(bytes);
    assert.deepEqual(rendered.getSize(), {
      width: page.width,
      height: page.height,
    });
    const single = await call(invoke, "carrot_export_page_png", {
      chapterId,
      pageId: page.pageId,
      revision: page.revision,
      requestId: randomUUID(),
    });
    await settle(invoke, single.jobId);
    const singleFile = await call(invoke, "carrot_get_job_file", {
      jobId: single.jobId,
    });
    const singleBytes = await download(origin, singleFile);
    assert.deepEqual(
      rendered.toBitmap(),
      nativeImage.createFromBuffer(singleBytes).toBitmap(),
    );
    files.set(page.filename, bytes);
  }
  return files;
}
/** Only called from the isolated native fixture; never reads or changes a user library.
 * @param {string} root @param {Invoke} invoke @param {string} chapterId
 * @param {import("../src/main/mcp/mcpArtifactStore").McpArtifactStore} artifacts */
async function checkNativeExportBatch(root, invoke, chapterId, artifacts) {
  const library = require(join(root, "out/main/library.js"));
  const { getAppPaths } = require(join(root, "out/main/appPaths.js"));
  assert.equal(getAppPaths().dataRoot, root, "Never use a real user data root");
  const redaction = require(join(root, "out/main/imageRedactionStore.js"));
  const { startMcpHttpServer } = require(
    join(root, "out/main/mcp/mcpHttpServer.js"),
  );
  const before = await library.openChapter(chapterId);
  const originals = await Promise.all(
    before.pages.map((/** @type {any} */ page) => readFile(page.imagePath)),
  );
  /** @type {unknown[]} */
  const errors = [];
  const http = await startMcpHttpServer({
    config: { port: 0, token: randomUUID().repeat(2) },
    tools: [],
    artifacts,
    reportError: (/** @type {unknown} */ error) => errors.push(error),
  });
  const origin = new URL(http.url).origin;
  try {
    const plan = await call(invoke, "carrot_preflight_pages_export", {
      chapterId,
    });
    assert.equal(plan.pages.length, 2);
    const target = {
      chapterId,
      snapshot: plan.snapshot,
      requestId: randomUUID(),
      pages: plan.pages.map(
        (/** @type {{pageId: string, revision: string}} */ page) => ({
          pageId: page.pageId,
          revision: page.revision,
        }),
      ),
    };
    const batch = await call(invoke, "carrot_export_pages_png", target);
    const receipt = await settle(invoke, batch.jobId);
    assert.equal(receipt.result.exportPages.completed, 2);
    assert.equal(
      (await call(invoke, "carrot_export_pages_png", target)).jobId,
      batch.jobId,
    );
    await assert.rejects(() =>
      call(invoke, "carrot_get_job_file", { jobId: batch.jobId }),
    );
    const files = await comparePages(
      invoke,
      chapterId,
      batch.jobId,
      plan.pages,
      origin,
    );
    const zip = await call(invoke, "carrot_create_export_zip", {
      sourceJobId: batch.jobId,
      requestId: randomUUID(),
    });
    await settle(invoke, zip.jobId);
    const file = await call(invoke, "carrot_get_job_file", {
      jobId: zip.jobId,
    });
    assert.equal(file.mimeType, "application/zip");
    const head = await fetch(origin + new URL(file.url).pathname, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(file.bytes));
    assert.equal(await head.text(), "");
    const entries = new AdmZip(await download(origin, file)).getEntries();
    assert.deepEqual(
      entries.map((/** @type {any} */ entry) => entry.entryName),
      [...files.keys(), "manifest.json"],
    );
    for (const entry of entries) {
      if (entry.entryName === "manifest.json")
        assert.doesNotMatch(
          entry.getData().toString(),
          /imagePath|mcp-artifacts|sourceText|translatedText/,
        );
      else assert.deepEqual(entry.getData(), files.get(entry.entryName));
    }
    assert.deepEqual(await library.openChapter(chapterId), before);
    for (const [index, page] of before.pages.entries())
      assert.deepEqual(await readFile(page.imagePath), originals[index]);
    await redaction.setImageRedactionEnabled(true, root);
    await assert.rejects(() =>
      call(invoke, "carrot_get_job_file", { jobId: zip.jobId }),
    );
    assert.equal(
      (await fetch(origin + new URL(file.url).pathname)).status,
      404,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS native two-page PNG parity (zero differing pixels), ordered ZIP byte equality, HTTP HEAD/GET and post-export redaction; saved pages and originals unchanged",
    );
  } finally {
    await http.close();
    await redaction.setImageRedactionEnabled(false, root);
  }
}
module.exports = { checkNativeExportBatch };
