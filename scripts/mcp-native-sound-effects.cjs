const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: pause } = require("node:timers/promises");

/** @typedef {(name: string, args: object) => Promise<Array<{text?: string}>>} Invoke */
/** @param {Invoke} invoke @param {string} chapterId @param {string} pageId */
function soundClient(invoke, chapterId, pageId) {
  /** @param {string} name @param {object} args */
  const call = async (name, args) => {
    const content = await invoke(`carrot_${name}`, args);
    assert.ok(content[0]?.text, `Missing sound-effect ${name} receipt`);
    const value = JSON.parse(content[0].text);
    assert.ok(!value.error, content[0].text);
    assert.doesNotMatch(
      content[0].text,
      /dataUrl|imagePath|inpaintedImagePath/,
    );
    return value;
  };
  /** @param {string} name @param {object} args */
  const done = async (name, args) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const value = await call(name, args);
      if (value.status === "completed") return value;
      assert.equal(value.status, "running", JSON.stringify(value));
      await pause(25);
    }
    throw new Error(
      "Native sound-effect action did not reach a terminal state",
    );
  };
  const inspect = () => call("get_sound_effects", { chapterId, pageId });
  /** @param {object} command */
  const prepare = async (command) => {
    const page = await inspect();
    const job = await call("prepare_sound_effect_batch", {
      chapterId,
      pageId,
      revision: page.revision,
      reviewRevision: page.reviewRevision,
      contextRevision: page.contextRevision,
      requestId: randomUUID(),
      reason: "Isolated native sound-effect review",
      command,
    });
    const result = await done("get_job", { jobId: job.jobId });
    assert.equal(result.result.pagesChanged, 0);
    assert.deepEqual(result.result.performed, ["sound_effect_preparation"]);
    return result.result.soundEffectPlan.batchId;
  };
  /** @param {string} batchId @param {string} direction */
  const action = async (batchId, direction) => {
    await call(`${direction}_sound_effect_batch`, {
      batchId,
      requestId: randomUUID(),
    });
    await done("get_sound_effect_batch", { batchId });
  };
  return { inspect, prepare, action };
}
/** @param {string} root @param {Invoke} invoke @param {string} chapterId */
async function checkNativeSoundEffects(root, invoke, chapterId) {
  const library = require(join(root, "out/main/library.js"));
  const { captureSoundEffectPage } = require(
    join(root, "out/shared/soundEffectPageSnapshot.js"),
  );
  const read = async () => (await library.openChapter(chapterId)).pages[0];
  const before = await read();
  const original = await readFile(before.imagePath);
  const client = soundClient(invoke, chapterId, before.id);
  const review = await client.prepare({
    kind: "review",
    decisions: [],
    additions: [
      {
        key: "native-sound",
        sourceRect: {
          x: before.width - 35,
          y: before.height - 40,
          w: 20,
          h: 25,
        },
      },
    ],
  });
  assert.deepEqual(
    captureSoundEffectPage(await read()),
    captureSoundEffectPage(before),
  );
  await client.action(review, "apply");
  const candidate = (await client.inspect()).items.find(
    /** @param {{id: string; kind: string}} item */ (item) =>
      item.kind === "candidate" && item.id.startsWith("manual-"),
  );
  assert.ok(candidate, "The native manual candidate was not stored");
  const materialize = await client.prepare({
    kind: "materialize",
    entries: [
      {
        regionId: candidate.id,
        sourceText: "SFX",
        translatedText: "BANG",
        allowOverlap: true,
      },
    ],
  });
  await client.action(materialize, "apply");
  const after = await read();
  assert.equal(after.blocks.length, before.blocks.length + 1);
  assert.deepEqual(after.blocks.slice(0, before.blocks.length), before.blocks);
  const block = after.blocks.at(-1);
  assert.equal(block.textRole, "sound");
  const text = await client.prepare({
    kind: "text",
    edits: [{ blockId: block.id, translatedText: "BANG!" }],
  });
  await client.action(text, "apply");
  assert.equal((await read()).blocks.at(-1).translatedText, "BANG!");
  await client.action(text, "undo");
  for (const action of ["undo", "redo", "undo"])
    await client.action(materialize, action);
  for (const action of ["undo", "redo", "undo"])
    await client.action(review, action);
  assert.deepEqual(
    captureSoundEffectPage(await read()),
    captureSoundEffectPage(before),
  );
  assert.deepEqual(await readFile(before.imagePath), original);
  console.log(
    "PASS native sound-effect candidate -> approved text block -> text-only edit -> exact review/block recovery (no inference)",
  );
}
module.exports = { checkNativeSoundEffects };
