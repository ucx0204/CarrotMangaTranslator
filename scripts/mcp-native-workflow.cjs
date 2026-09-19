const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { retainedClient } = require("./mcp-native-retention.cjs");

/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** @typedef {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} NativeApp */
/** @typedef {{assertWritable: (chapterId:string,pageId:string)=>Promise<void>, assertClean: (chapterId:string,pageId:string)=>Promise<void>, notifySaved: (chapterId:string,pageId:string)=>void}} Editing */
/** @typedef {{chapterId:string,pageId:string,revision:string,reviewRevision:string}} Target */

/** Actual native composition, OS encryption and renderer; no model or public connection.
 * @param {string} root @param {NativeApp} app @param {Editing} editing @param {string} chapterId */
async function checkNativeWorkflow(root, app, editing, chapterId) {
  const library = require(join(root, "out/main/library.js"));
  const { createPageRevision } = require(join(root, "out/shared/pageRevision.js"));
  const { capturePageRecovery } = require(join(root, "out/shared/pageRecoverySnapshot.js"));
  const chapter = await library.openChapter(chapterId);
  const before = chapter.pages.map(capturePageRecovery);
  const originals = await Promise.all(chapter.pages.map((/** @type {{imagePath:string}} */ page) => readFile(page.imagePath)));
  let client = await retainedClient(root, app, editing);
  try {
    const plan = await client.call("prepare_workflow", {
      requestId: randomUUID(), reason: "Isolated native workflow reconstruction",
      chapters: [{ chapterId, pages: chapter.pages.map((/** @type {import("../src/shared/libraryTypes").MangaPage} */ page) => ({ pageId: page.id, revision: createPageRevision(page) })) }],
      stages: [{ kind: "await-external", purpose: "translation" }, { kind: "export-png" }],
    });
    assert.equal(plan.status, "prepared");
    await client.close();
    client = await retainedClient(root, app, editing);
    assert.equal((await client.call("get_workflow", { id: plan.id })).status, "prepared");
    for (const page of chapter.pages) await acknowledgeSavedPage(client, plan.id, chapterId, page.id);
    const current = await client.call("get_workflow", { id: plan.id });
    const request = { id: plan.id, version: current.version, requestId: randomUUID() };
    await client.call("resume_workflow", request);
    const complete = await waitWorkflow(client, plan.id);
    assert.equal(complete.status, "completed", JSON.stringify(complete));
    assert.equal(complete.completedSteps, chapter.pages.length * 2);
    const outputIds = complete.steps.filter((/** @type {{stage:string}} */ step) => step.stage === "export-png").map((/** @type {{outputId:string}} */ step) => step.outputId);
    const outputs = await collectWorkflowOutputs(client, outputIds);
    const oldArtifacts = client.artifacts;
    await client.close();
    client = await retainedClient(root, app, editing);
    const restored = await client.call("get_workflow", { id: plan.id });
    assert.equal(restored.status, "completed");
    assert.deepEqual(restored.steps, complete.steps);
    await client.call("resume_workflow", request);
    assert.deepEqual((await client.call("get_workflow", { id: plan.id })).steps, complete.steps);
    for (const output of outputs) {
      await assert.rejects(() => oldArtifacts.read(new URL(output.url).pathname.split("/")[2]));
      const fresh = await client.call("get_output_file", { id: output.id });
      assert.notEqual(fresh.url, output.url);
      assert.deepEqual(await client.artifacts.read(new URL(fresh.url).pathname.split("/")[2]), output.bytes);
      await client.call("discard_retained", { id: output.id, confirm: true });
    }
    await client.call("discard_workflow", { id: plan.id, confirm: true });
    assert.deepEqual((await library.openChapter(chapterId)).pages.map(capturePageRecovery), before);
    for (const [index, page] of chapter.pages.entries()) assert.deepEqual(await readFile(page.imagePath), originals[index]);
    console.log("PASS native workflow prepare -> reconstructed external wait -> explicit saved-revision acknowledgements -> real PNG stages -> reconstructed exact replay and byte-identical retained outputs");
  } finally { await client.close(); }
}

/** @param {Client} client @param {string} id @param {string} chapterId @param {string} pageId */
async function acknowledgeSavedPage(client, id, chapterId, pageId) {
  const view = await client.call("get_workflow", { id });
  await client.call("run_workflow", { id, version: view.version, requestId: randomUUID() });
  const waiting = await waitWorkflow(client, id);
  assert.equal(waiting.status, "waiting_external");
  const page = waiting.pages.find((/** @type {Target} */ target) => target.chapterId === chapterId && target.pageId === pageId);
  assert.ok(page);
  const accepted = await client.call("accept_workflow_external", { id, version: waiting.version, requestId: randomUUID(), page });
  assert.equal(accepted.status, "paused");
}

/** @param {Client} client @param {string[]} ids */
async function collectWorkflowOutputs(client, ids) {
  assert.equal(new Set(ids).size, ids.length);
  const result = [];
  for (const id of ids) {
    assert.ok(id);
    const file = await client.call("get_output_file", { id });
    const bytes = await client.artifacts.read(new URL(file.url).pathname.split("/")[2]);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    assert.equal(bytes.length, file.bytes);
    result.push({ id, url: file.url, bytes });
  }
  return result;
}

/** @param {Client} client @param {string} id */
async function waitWorkflow(client, id) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const view = await client.call("get_workflow", { id });
    if (view.status !== "running") return view;
    await pause(30);
  }
  throw new Error("Native workflow did not settle");
}
module.exports = { checkNativeWorkflow };
