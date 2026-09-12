const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { nativeImage } = require("electron");

/** @param {string} root @param {string} name */
function load(root, name) {
  return require(join(root, "out", name));
}
/** @param {string} root */
async function seedPage(root) {
  const bitmap = Buffer.alloc(400 * 600 * 4, 255);
  for (const [left, top, width, height] of [
    [65, 75, 18, 55],
    [100, 75, 18, 55],
    [300, 500, 20, 20],
  ])
    for (let y = top; y < top + height; y++)
      for (let x = left; x < left + width; x++)
        bitmap.fill(0, (y * 400 + x) * 4, (y * 400 + x) * 4 + 3);
  const sourcePath = join(root, "page-goal-original.png");
  await writeFile(
    sourcePath,
    nativeImage.createFromBitmap(bitmap, { width: 400, height: 600 }).toPNG(),
  );
  const library = load(root, "main/library.js");
  const imported = await library.createImport({
    preview: {
      mode: "single",
      sourceKind: "images",
      suggestedWorkTitle: "Page goal fixture",
      chapters: [
        {
          draftId: "page",
          title: "Page goal",
          sourceKind: "images",
          pages: [{ name: "page.png", sourcePath, sourceKind: "file" }],
        },
      ],
    },
    target: { mode: "new", title: "Page goal fixture" },
    selections: [{ draftId: "page", title: "Page goal", enabled: true }],
  });
  return library.openChapter(imported.chapterIds[0]);
}
/** @param {Buffer} png @param {number} x @param {number} y */
function pixel(png, x, y) {
  const image = nativeImage.createFromBuffer(png);
  return [
    ...image
      .toBitmap()
      .subarray(
        (y * image.getSize().width + x) * 4,
        (y * image.getSize().width + x) * 4 + 3,
      ),
  ];
}
/** Deterministic inference boundary only: real app mask construction, compositing,
 * revision checks, image history and renderer still execute. No model is downloaded.
 * @param {Buffer} bitmap @param {number} width @param {number} height @param {Uint8Array} mask */
async function syntheticInference(bitmap, width, height, mask) {
  assert.equal(mask.length, width * height);
  for (let index = 0; index < mask.length; index++)
    if (mask[index]) bitmap.fill(255, index * 4, index * 4 + 4);
}
/** @param {string} root */
async function checkNativePageGoal(root) {
  const library = load(root, "main/library.js");
  const { getAppPaths } = load(root, "main/appPaths.js");
  const { createPageRevision } = load(root, "shared/pageRevision.js");
  const { ActiveJobStore } = load(root, "main/jobs/activeJob.js");
  const { InpaintingRevisionStore } = load(
    root,
    "main/inpainting/inpaintingRevisionStore.js",
  );
  const { createMcpAppTools } = load(root, "main/mcp/mcpAppTools.js");
  const { createMcpPageOperationSession } = load(
    root,
    "main/mcp/mcpPageOperationSession.js",
  );
  const redaction = load(root, "main/imageRedactionStore.js");
  await redaction.setImageRedactionEnabled(false, root);
  load(root, "main/imageProtocol.js").registerImageProtocolHandler();
  const chapter = await seedPage(root);
  const page = chapter.pages[0];
  const original = await readFile(page.imagePath);
  const app = {
    appPaths: getAppPaths(),
    jobs: new ActiveJobStore(),
    getMainWindow: () => null,
    decodeImage: async () => null,
    inpaintingRevisionStore: new InpaintingRevisionStore(),
  };
  const editing = {
    assertWritable: async () => {},
    assertClean: async () => {},
    notifySaved: () => {},
  };
  let allowed = true;
  const context = {
    assertAuthorized: () => {
      assert.equal(allowed, true, "revoked");
    },
    principalId: "native-fixture",
  };
  const preferences = {
    allowImages: true,
    allowEditing: true,
    allowProcessing: true,
    autoStart: false,
  };
  const session = createMcpPageOperationSession({
    origin: "https://carrot-native.example",
    preferences,
    app,
    editing,
    reportError: (/** @type {unknown} */ error) => console.error(error),
  });
  const tools = createMcpAppTools({
    ...editing,
    preferences,
    additionalTools: session.tools,
  });
  /** @param {string} name @param {object} args */
  const invoke = async (name, args) => {
    const tool = tools.find(
      (/** @type {{name: string}} */ item) => item.name === name,
    );
    assert.ok(tool, name);
    return tool.invoke(args, context);
  };
  try {
    const created = await invoke("carrot_create_page_blocks", {
      chapterId: chapter.id,
      pageId: page.id,
      revision: createPageRevision(page),
      requestId: randomUUID(),
      blocks: [
        {
          key: "dialogue",
          sourceText: "source",
          translatedText: "Hello MCP",
          sourceRect: { x: 40, y: 50, w: 130, h: 115 },
        },
      ],
    });
    assert.equal(JSON.parse(created[0].text).status, "saved");
    const translated = (await library.openChapter(chapter.id)).pages[0];
    await checkErasure(root, app, editing, chapter.id, translated);
    const erased = (await library.openChapter(chapter.id)).pages[0];
    assert.deepEqual(erased.blocks, translated.blocks);
    assert.deepEqual(await readFile(page.imagePath), original);
    const clean = await readFile(erased.inpaintedImagePath);
    assert.deepEqual(pixel(clean, 73, 95), [255, 255, 255]);
    assert.deepEqual(pixel(clean, 305, 505), [0, 0, 0]);
    const started = await invoke("carrot_export_page_png", {
      chapterId: chapter.id,
      pageId: page.id,
      revision: createPageRevision(erased),
      requestId: randomUUID(),
    });
    const result = await waitForOutput(
      invoke,
      JSON.parse(started[0].text).jobId,
    );
    const bytes = await session.artifacts.read(
      new URL(result.url).pathname.split("/")[2],
    );
    assert.deepEqual(nativeImage.createFromBuffer(bytes).getSize(), {
      width: 400,
      height: 600,
    });
    assert.deepEqual(pixel(bytes, 305, 505), [0, 0, 0]);
    assert.notDeepEqual(
      nativeImage.createFromBuffer(bytes).toBitmap(),
      nativeImage.createFromBuffer(clean).toBitmap(),
      "The renderer must actually add translated lettering",
    );
    assert.equal(JSON.stringify(result).includes(root), false);
    allowed = false;
    await assert.rejects(() =>
      session.artifacts.read(new URL(result.url).pathname.split("/")[2]),
    );
    console.log(
      "PASS native external blocks -> app masks/local-engine boundary -> real renderer -> original-resolution PNG -> revoked link",
    );
  } finally {
    await session.close();
  }
}
/** @param {string} root @param {object} app @param {object} editing @param {string} chapterId @param {{id: string}} page */
async function checkErasure(root, app, editing, chapterId, page) {
  const { eraseMcpPage } = load(root, "main/mcp/mcpErasureAdapter.js");
  const { productionInpaintingJobRuntime } = load(
    root,
    "main/jobs/inpaintingJobRuntime.js",
  );
  const { createPageRevision } = load(root, "shared/pageRevision.js");
  const runtime = {
    ...productionInpaintingJobRuntime,
    acquireEngine: async () => ({
      engine: {
        model: "flux-klein",
        backend: "synthetic-test",
        runtimePath: "synthetic",
        runRootDir: root,
        inpaint: syntheticInference,
        dispose: async () => {},
      },
      release: () => {},
    }),
  };
  const result = await eraseMcpPage(
    app,
    editing,
    {
      chapterId,
      pageId: page.id,
      revision: createPageRevision(page),
      requestId: randomUUID(),
    },
    {
      id: randomUUID(),
      signal: new AbortController().signal,
      assertAuthorized: () => {},
      progress: () => {},
    },
    runtime,
  );
  assert.equal(result.status, "completed");
  assert.ok(result.blocksErased > 0);
}
/** @param {(name: string, args: object) => Promise<Array<{text: string}>>} invoke @param {string} jobId */
async function waitForOutput(invoke, jobId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const content = await invoke("carrot_get_job", { jobId });
    const receipt = JSON.parse(content[0].text);
    if (receipt.status !== "running") {
      assert.equal(receipt.status, "completed", JSON.stringify(receipt));
      return receipt.result;
    }
    await delay(100);
  }
  throw new Error("Page export did not finish within the native test deadline");
}
module.exports = { checkNativePageGoal };
