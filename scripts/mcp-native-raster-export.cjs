const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const { join, dirname } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { nativeImage, BrowserWindow } = require("electron");
const { retainedClient } = require("./mcp-native-retention.cjs");

/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** @typedef {{id:string, bytes:Buffer, mimeType:string}} RetainedFile */
/** @param {string} root
 * @param {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} app
 * @param {Parameters<typeof retainedClient>[2]} editing
 * @param {string} chapterId
 * @returns {Promise<RetainedFile[]>} */
async function checkNativeRasterExports(root, app, editing, chapterId) {
  assert.equal(
    root,
    app.appPaths.dataRoot,
    "Use only the isolated fixture profile",
  );
  const library = require(join(root, "out/main/library.js"));
  const { probeImageBuffer } = require(
    join(root, "out/main/libraryStore/imageHeaderProbe.js"),
  );
  let client = await retainedClient(root, app, editing);
  const stopHandoffs = acknowledgeRasterHandoffs(app.jobs.pageHandoffs);
  /** @type {RetainedFile[]} */
  const saved = [];
  try {
    const chapter = await prepareRasterFixture(library, client, chapterId);
    const chapterPath = join(
      library.getLibraryRoot(),
      "works",
      chapter.workId,
      "chapters",
      chapter.id,
      "chapter.json",
    );
    const chapterBytes = await readFile(chapterPath);
    const page = chapter.pages[0];
    assert.ok(page.inpaintedImagePath);
    const original = await readFile(page.imagePath);
    const background = await readFile(page.inpaintedImagePath);
    for (const options of [
      { format: "png", omitText: false },
      { format: "jpeg", omitText: false, quality: 95 },
      { format: "webp", omitText: false, quality: 90 },
      { format: "png", omitText: true },
    ]) {
      const result = await exportRaster(client, chapterId, page.id, options);
      saved.push({
        id: result.id,
        bytes: result.bytes,
        mimeType: result.mimeType,
      });
      assert.equal(
        probeImageBuffer(result.bytes, result.filename).format,
        options.format,
      );
      // NativeImage supports PNG/JPEG; Chromium decodes the actual WebP output too.
      const size = await decodeRaster(result.bytes, result.mimeType);
      assert.deepEqual(size, {
        width: page.width,
        height: page.height,
      });
      if (options.omitText)
        assert.deepEqual(
          nativeImage.createFromBuffer(result.bytes).toBitmap(),
          nativeImage.createFromBuffer(background).toBitmap(),
        );
      saved.push(await checkZip(client, result, options));
    }
    await client.close();
    client = await retainedClient(root, app, editing);
    for (const output of saved) {
      const file = await client.call("get_output_file", { id: output.id });
      assert.equal(file.mimeType, output.mimeType);
      assert.deepEqual(await readArtifact(client, file.url), output.bytes);
      await client.call("discard_retained", { id: output.id, confirm: true });
    }
    assert.deepEqual(await library.openChapter(chapterId), chapter);
    assert.deepEqual(await readFile(chapterPath), chapterBytes);
    assert.deepEqual(await readFile(page.imagePath), original);
    assert.deepEqual(await readFile(page.inpaintedImagePath), background);
    console.log(
      "PASS native raster export -> actual PNG JPEG WebP and textless pixels -> ZIP -> reconstructed retained byte-identical reissue",
    );
    return saved;
  } finally {
    stopHandoffs();
    await client.close();
  }
}

/** The fixture is prepared separately, never by asking export to erase or forge readiness.
 * @param {typeof import("../src/main/library")} library
 * @param {Client} client @param {string} chapterId */
async function prepareRasterFixture(library, client, chapterId) {
  const before = await library.openChapter(chapterId);
  const page = before.pages[0];
  assert.ok(
    !page.inpaintedImagePath,
    "Import fixture starts without a cleaned background",
  );
  await assert.rejects(
    () =>
      exportRaster(client, chapterId, page.id, {
        format: "png",
        omitText: true,
      }),
    /"status":"failed"/,
  );
  assert.deepEqual(await library.openChapter(chapterId), before);
  const path = join(
    dirname(page.imagePath),
    `native-raster-background-${randomUUID()}.png`,
  );
  const pixels = Buffer.alloc(page.width * page.height * 4, 255);
  for (let offset = 0; offset < pixels.length; offset += 4)
    pixels[offset] = 100;
  await writeFile(
    path,
    nativeImage
      .createFromBitmap(pixels, {
        width: page.width,
        height: page.height,
      })
      .toPNG(),
  );
  // Real native metadata publication with a synthetic, explicitly supplied background.
  // This is not a model-inpainting quality test.
  await library.setPageInpaintingResult(chapterId, page.id, path);
  // Compare against the saved representation, not transient undefined-valued fields.
  return library.openChapter(chapterId);
}

/** @param {Client} client
 * @param {Awaited<ReturnType<typeof exportRaster>>} source
 * @param {{format:string, omitText:boolean, quality?:number}} options
 * @returns {Promise<RetainedFile>} */
async function checkZip(client, source, options) {
  const job = await client.call("create_export_zip", {
    sourceJobId: source.jobId,
    requestId: randomUUID(),
  });
  const result = await wait(client, job.jobId);
  const file = await client.call("get_job_file", { jobId: job.jobId });
  const bytes = await readArtifact(client, file.url);
  const Zip = require("adm-zip");
  const archive = Object.fromEntries(
    new Zip(bytes)
      .getEntries()
      .map((entry) => [entry.entryName, entry.getData()]),
  );
  assert.deepEqual(archive[source.filename], source.bytes);
  assert.deepEqual(
    JSON.parse(archive["manifest.json"].toString()).imageExport,
    options,
  );
  assert.ok(result.retainedOutputId);
  return { id: result.retainedOutputId, bytes, mimeType: "application/zip" };
}
/** @param {Client} client @param {string} chapterId @param {string} pageId
 * @param {{format:string, omitText:boolean, quality?:number}} imageExport */
async function exportRaster(client, chapterId, pageId, imageExport) {
  const plan = await client.call("preflight_pages_export", {
    chapterId,
    pageIds: [pageId],
    imageExport,
  });
  const command = {
    chapterId,
    imageExport: plan.imageExport,
    snapshot: plan.snapshot,
    pages: plan.pages.map(
      (/** @type {{pageId:string,revision:string}} */ page) => ({
        pageId: page.pageId,
        revision: page.revision,
      }),
    ),
    requestId: randomUUID(),
  };
  const tool =
    imageExport.format === "psd" ? "export_pages_psd" : "export_pages_images";
  const job = await client.call(tool, command);
  const result = await wait(client, job.jobId);
  assert.doesNotMatch(JSON.stringify(result), /mcp-artifacts|resource_link/);
  const metadata = result.exportPages.pages[0];
  assert.ok(metadata.retainedOutputId);
  const file = await client.call("get_job_file", { jobId: job.jobId, pageId });
  const bytes = await readArtifact(client, file.url);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  assert.equal((await client.call(tool, command)).jobId, job.jobId);
  return {
    id: metadata.retainedOutputId,
    filename: metadata.filename,
    jobId: job.jobId,
    bytes,
    mimeType: file.mimeType,
  };
}
/** @param {Client} client @param {string} url */
function readArtifact(client, url) {
  return client.artifacts.read(new URL(url).pathname.split("/")[2]);
}
/** @param {Client} client @param {string} jobId */
async function wait(client, jobId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const job = await client.call("get_job", { jobId });
    if (job.status !== "running") {
      assert.equal(job.status, "completed", JSON.stringify(job));
      return job.result;
    }
    await pause(30);
  }
  throw new Error("Native raster output timed out");
}
/** Only this isolated fixture supplies the response normally sent by the editor.
 * @param {import("../src/main/jobs/activeJob").ActiveJobStore["pageHandoffs"]} handoffs */
function acknowledgeRasterHandoffs(handoffs) {
  return handoffs.subscribe(() => {
    for (const handoff of handoffs.activities)
      if (handoff.phase === "finishing-edits" && handoff.requestId)
        handoffs.respond({ requestId: handoff.requestId });
  });
}
/** Decode actual produced bytes in a sandboxed local Chromium page, without network.
 * @param {Buffer} bytes @param {string} mimeType */
async function decodeRaster(bytes, mimeType) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    const markup = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:">`;
    await window.loadURL(`data:text/html,${encodeURIComponent(markup)}`);
    const source = `data:${mimeType};base64,${bytes.toString("base64")}`;
    return await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(source)};
      return Promise.race([
        image.decode().then(() => ({width: image.naturalWidth, height: image.naturalHeight})),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Raster decode timed out')), 5000)),
      ]);
    })()`);
  } finally {
    window.destroy();
  }
}
module.exports = {
  checkNativeRasterExports,
  exportRaster,
  checkZip,
  readArtifact,
  acknowledgeRasterHandoffs,
};
