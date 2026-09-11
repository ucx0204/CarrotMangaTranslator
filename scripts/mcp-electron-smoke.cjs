const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { cp, mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { promisify } = require("node:util");
const { app, nativeImage } = require("electron");

const root = resolve(__dirname, "..");
const exec = promisify(execFile);

/** @param {string} dataRoot */
async function importFixture(dataRoot) {
  const { getAppPaths } = require(join(dataRoot, "out/main/appPaths.js"));
  assert.equal(getAppPaths().dataRoot, dataRoot, "Never use a real user data root");
  const library = require(join(dataRoot, "out/main/library.js"));
  const sourcePath = join(dataRoot, "sample.png");
  const image = nativeImage.createFromBitmap(Buffer.alloc(32 * 48 * 4, 255), { width: 32, height: 48 });
  await writeFile(sourcePath, image.toPNG());
  return library.createImport({
    preview: {
      mode: "single", sourceKind: "images", suggestedWorkTitle: "MCP smoke fixture",
      chapters: [{ draftId: "sample", title: "Sample", sourceKind: "images", pages: [{ name: "sample.png", sourcePath, sourceKind: "file" }] }],
    },
    target: { mode: "new", title: "MCP smoke fixture" },
    selections: [{ draftId: "sample", title: "Sample", enabled: true }],
  });
}

/** @param {string} url @param {string} token @param {string} name @param {object} [args] */
async function call(url, token, name, args = {}) {
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

/** @param {string} dataRoot */
async function checkRuntime(dataRoot) {
  const imported = await importFixture(dataRoot);
  const { createMcpRuntime } = require(join(dataRoot, "out/main/mcpRuntime.js"));
  const token = randomBytes(32).toString("base64url");
  let url = "";
  /** @type {unknown[]} */
  const errors = [];
  const runtime = createMcpRuntime({
    env: { CARROT_MCP_ENABLED: "1", CARROT_MCP_TOKEN: token, CARROT_MCP_PORT: "38475", CARROT_MCP_ALLOW_IMAGES: "1" },
    reportError: (/** @type {string} */ _message, /** @type {unknown} */ error) => errors.push(error),
    reportInfo: (/** @type {string} */ _message, /** @type {{url: string}} */ detail) => { url = detail.url; },
  });
  let preview;
  try {
    await runtime.start();
    assert.ok(url.endsWith("/mcp"));
    const { stdout } = await exec("node", [join(root, "scripts/mcp-smoke.mjs"), "--first-preview"], {
      env: { ...process.env, CARROT_MCP_TOKEN: token, CARROT_MCP_URL: url }, timeout: 25_000,
    });
    preview = stdout.match(/PASS PNG preview saved: ([^\r\n]+)/)?.[1];
    assert.ok(preview);
    console.log(stdout);
    assert.deepEqual(errors, []);
    const chapterResult = await call(url, token, "carrot_get_chapter", { chapterId: imported.chapterIds[0] });
    const chapter = JSON.parse(chapterResult.content[0].text);
    const redaction = require(join(dataRoot, "out/main/imageRedactionStore.js"));
    await redaction.setImageRedactionEnabled(true, dataRoot);
    const blocked = await call(url, token, "carrot_get_page_preview", { chapterId: chapter.id, pageId: chapter.pages[0].id });
    assert.equal(blocked.isError, true);
    assert.equal(blocked.content.some((/** @type {{type: string}} */ item) => item.type === "image"), false);
    assert.equal(JSON.stringify(blocked).includes(dataRoot), false);
    console.log("PASS real Electron redaction gate blocked image transfer");
  } finally {
    await runtime.dispose();
    if (preview) await rm(preview, { force: true });
  }
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
  console.log("PASS real Electron MCP runtime stopped and listener closed");
}

async function main() {
  await app.whenReady();
  await mkdir(join(root, ".tmp"), { recursive: true });
  const dataRoot = await mkdtemp(join(root, ".tmp/mcp-native-"));
  try {
    // Only compiled code is copied; no existing library/settings/fonts are used.
    await cp(join(root, "out/main"), join(dataRoot, "out/main"), { recursive: true });
    await cp(join(root, "out/shared"), join(dataRoot, "out/shared"), { recursive: true });
    await checkRuntime(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().then(
  () => app.exit(0),
  (error) => { console.error(error); app.exit(1); },
);
