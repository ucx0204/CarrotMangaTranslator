const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");
const { checkNativeResearchBatch } = require("./mcp-native-research-batch.cjs");

/** @typedef {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} NativeApp */
/** @typedef {Parameters<typeof retainedClient>[2]} Editing */
/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */

/** Real native tools and OS encryption; only the smoke harness's temporary work.
 * @param {string} root @param {NativeApp} app @param {Editing} editing @param {string} chapterId */
async function checkNativeResearchProposal(root, app, editing, chapterId) {
  const library = require(join(root, "out/main/library.js"));
  const before = await library.readWorkContextForEdit(chapterId);
  const original = await readFile(before.chapter.pages[0].imagePath);
  const memoryPath = join(
    library.getLibraryRoot(),
    "works",
    before.workId,
    "chapters",
    chapterId,
    "story-memory.json",
  );
  await assert.rejects(() => stat(memoryPath), { code: "ENOENT" });
  let client = await retainedClient(root, app, editing);
  try {
    const request = await proposalInput(client, chapterId);
    const proposal = await client.call("preview_context_research", request);
    const args = { proposalId: proposal.proposalId };
    const review = await client.call("get_context_proposal", args);
    assert.equal(review.retention, "seven-days");
    assert.equal(review.changes.length, 2);
    assert.deepEqual(
      await library.getWorkStyleGuide(before.workId),
      before.styleGuide,
    );
    const encrypted = await readFile(
      join(
        library.getLibraryRoot(),
        ".mcp-retained",
        proposal.proposalId,
        "record.json",
      ),
      "utf8",
    );
    assert.doesNotMatch(
      encrypted,
      /Native retained term|example.com\/research/,
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    assert.deepEqual(await client.call("get_context_proposal", args), review);
    assert.deepEqual(
      await client.call("preview_context_research", request),
      proposal,
    );
    const listed = await client.call("list_context_proposals", {});
    assert.ok(
      listed.items.some(
        (/** @type {{id:string}} */ item) => item.id === proposal.proposalId,
      ),
    );
    const command = {
      ...args,
      requestId: randomUUID(),
      selectedChangeIds: ["term"],
    };
    const applied = await client.call("apply_context_proposal", command);
    assert.equal(applied.changesApplied, 1);
    assert.ok(applied.recoveryId);
    const after = await library.getWorkStyleGuide(before.workId);
    assert.equal(after.glossary.at(-1).id, review.changes[0].targetId);
    assert.deepEqual(after.characters, before.styleGuide.characters);
    await client.close();
    client = await retainedClient(root, app, editing);
    for (const direction of ["undo", "redo", "undo"]) {
      const state = await client.call("get_context_migration", {
        id: applied.recoveryId,
      });
      assert.equal(direction === "undo" ? state.canUndo : state.canRedo, true);
      await client.call(`${direction}_context_migration`, {
        id: applied.recoveryId,
        requestId: randomUUID(),
        referenceSnapshot: state.referenceSnapshot,
      });
      assert.deepEqual(
        await library.getWorkStyleGuide(before.workId),
        direction === "undo" ? before.styleGuide : after,
      );
    }
    assert.equal(
      (await client.call("apply_context_proposal", command)).status,
      "already_applied",
    );
    assert.deepEqual(
      await library.getWorkStyleGuide(before.workId),
      before.styleGuide,
    );
    for (const id of [proposal.proposalId, applied.recoveryId])
      await client.call("discard_retained", { id, confirm: true });
    await assert.rejects(() => client.call("get_context_proposal", args));
    const current = await library.readWorkContextForEdit(chapterId);
    assert.deepEqual(
      current.chapter.pages.map(
        (/** @type {{blocks:unknown}} */ page) => page.blocks,
      ),
      before.chapter.pages.map(
        (/** @type {{blocks:unknown}} */ page) => page.blocks,
      ),
    );
    // Absent-file defaults have a fresh read timestamp; actual storage must stay absent.
    assert.deepEqual(current.storyMemory.pages, before.storyMemory.pages);
    assert.equal(current.storyMemory.workId, before.storyMemory.workId);
    assert.equal(current.storyMemory.chapterId, before.storyMemory.chapterId);
    await assert.rejects(() => stat(memoryPath), { code: "ENOENT" });
    assert.deepEqual(
      await readFile(before.chapter.pages[0].imagePath),
      original,
    );
    await checkNativeResearchBatch(root, app, editing, chapterId);
    console.log(
      "PASS native retained research -> OS-encrypted review -> reconstructed selection -> exact undo/redo -> historical replay; original text and pixels preserved",
    );
  } finally {
    await client.close();
  }
}

/** @param {Client} client @param {string} chapterId */
async function proposalInput(client, chapterId) {
  const context = await client.call("get_work_context", { chapterId });
  const changes = [
    {
      changeId: "term",
      entity: "glossary",
      values: {
        source: "Native retained term",
        target: "Reviewed native term",
      },
    },
    {
      changeId: "unselected",
      entity: "character",
      values: { displayName: "Must not be added" },
    },
  ];
  return {
    chapterId,
    revision: context.revision,
    requestId: randomUUID(),
    changes: changes.map((change) => ({
      change,
      reason: "Synthetic caller-reviewed evidence",
      sources: [{ title: "Fixture", url: "https://example.com/research" }],
    })),
  };
}

module.exports = { checkNativeResearchProposal };
