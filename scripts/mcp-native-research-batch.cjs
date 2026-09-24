const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");
const { retainedClient } = require("./mcp-native-retention.cjs");

/** @typedef {Parameters<typeof retainedClient>[1]} NativeApp */
/** @typedef {Parameters<typeof retainedClient>[2]} Editing */
/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */

/** Real native tools and OS encryption; all research is held, so no provider is contacted.
 * @param {string} root @param {NativeApp} app @param {Editing} editing @param {string} chapterId */
async function checkNativeResearchBatch(root, app, editing, chapterId) {
  const library = require(join(root, "out/main/library.js"));
  const before = await library.openChapter(chapterId);
  const original = await readFile(before.pages[0].imagePath);
  const second = await seedSecondWork(library, before.pages[0].imagePath);
  let client = await retainedClient(root, app, editing);
  try {
    const works = [];
    for (const id of [chapterId, second]) {
      const context = await client.call("get_work_context", { chapterId: id });
      const references = await client.call("get_context_references", {
        chapterId: id,
      });
      works.push({
        workId: context.workId,
        chapterId: id,
        revision: context.revision,
        referenceSnapshot: references.snapshot,
        researchTitle: "Unconfirmed native fixture",
        engine: "tavily",
        titleConfirmed: false,
        allowSpoilers: false,
      });
    }
    const input = { requestId: randomUUID(), works, maxAttempts: 2 };
    const plan = await client.call("prepare_research_batch", input);
    assert.equal(plan.works.length, 2);
    assert.ok(
      plan.works.every(
        (/** @type {{status:string}} */ work) => work.status === "held",
      ),
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    assert.deepEqual(
      await client.call("get_research_batch", { id: plan.id }),
      plan,
    );
    assert.deepEqual(await client.call("prepare_research_batch", input), plan);
    const command = {
      id: plan.id,
      version: plan.version,
      requestId: randomUUID(),
      allowExternal: true,
    };
    await client.call("run_research_batch", command);
    const settled = await settleBatch(client, plan.id);
    assert.equal(settled.status, "partial");
    assert.equal(settled.attemptsUsed, 0);
    assert.equal(settled.unknownUsageAttempts, 0);
    await client.close();
    client = await retainedClient(root, app, editing);
    assert.deepEqual(await client.call("run_research_batch", command), settled);
    assert.ok(
      (await client.call("list_research_batches", {})).items.some(
        (/** @type {{id:string}} */ item) => item.id === plan.id,
      ),
    );
    await client.call("pause_research_batch", { id: plan.id });
    const cancelled = await client.call("cancel_research_batch", {
      id: plan.id,
    });
    assert.equal(cancelled.status, "cancelled");
    const resolved = await client.call("resolve_research_hold", {
      id: plan.id,
      version: cancelled.version,
      requestId: randomUUID(),
      workId: works[0].workId,
      researchTitle: "Explicit native fixture",
      titleConfirmed: true,
      allowSpoilers: true,
    });
    assert.equal(resolved.status, "paused");
    assert.equal(resolved.attemptsUsed, 0);
    await assert.rejects(() =>
      client.call("discard_retained", { id: plan.id, confirm: true }),
    );
    await client.call("discard_research_batch", { id: plan.id, confirm: true });
    await assert.rejects(() =>
      client.call("get_research_batch", { id: plan.id }),
    );
    assert.deepEqual(
      (await library.openChapter(chapterId)).pages.map(
        (/** @type {{blocks:unknown}} */ page) => page.blocks,
      ),
      before.pages.map((/** @type {{blocks:unknown}} */ page) => page.blocks),
    );
    assert.deepEqual(await readFile(before.pages[0].imagePath), original);
    console.log(
      "PASS native multi-work research plan -> OS-encrypted restart -> held run -> explicit resolution without inference -> owned disposal; original preserved",
    );
  } finally {
    await client.close();
  }
}

/** @param {{createImport: (input: object) => Promise<{chapterIds:string[]}>}} library @param {string} sourcePath */
async function seedSecondWork(library, sourcePath) {
  const result = await library.createImport({
    preview: {
      mode: "single",
      sourceKind: "images",
      suggestedWorkTitle: "Native research batch fixture",
      chapters: [
        {
          draftId: "sample",
          title: "Sample",
          sourceKind: "images",
          pages: [{ name: "sample.png", sourcePath, sourceKind: "file" }],
        },
      ],
    },
    target: { mode: "new", title: "Native research batch fixture" },
    selections: [{ draftId: "sample", title: "Sample", enabled: true }],
  });
  return result.chapterIds[0];
}
/** @param {Client} client @param {string} id */
async function settleBatch(client, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await client.call("get_research_batch", { id });
    if (value.status !== "running") return value;
    await pause(20);
  }
  throw new Error("Held native research batch did not settle");
}
module.exports = { checkNativeResearchBatch };
