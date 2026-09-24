const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { retainedClient } = require("./mcp-native-retention.cjs");
const {
  checkNativeResearchProposal,
} = require("./mcp-native-research-proposal.cjs");

/** @typedef {import("../src/main/jobs/inpaintingJobTypes").InpaintingJobContext} NativeApp */
/** @typedef {{assertWritable: (chapterId:string,pageId:string)=>Promise<void>, assertClean: (chapterId:string,pageId:string)=>Promise<void>, notifySaved: (chapterId:string,pageId:string)=>void}} Editing */
/** @typedef {Awaited<ReturnType<typeof retainedClient>>} Client */
/** @typedef {import("../src/shared/mcpContextReferences").McpContextReferenceSnapshot} Graph */

/** A new work inside the smoke harness's temporary library only.
 * @param {string} root @param {string} sourceChapterId */
async function seedContextWork(root, sourceChapterId) {
  const library = require(join(root, "out/main/library.js"));
  const source = (await library.openChapter(sourceChapterId)).pages[0];
  const drafts = ["context-one", "context-two"].map((draftId) => ({
    draftId,
    title: draftId,
    sourceKind: "images",
    pages: [
      {
        name: `${draftId}.png`,
        sourcePath: source.imagePath,
        sourceKind: "file",
      },
    ],
  }));
  const imported = await library.createImport({
    preview: {
      mode: "batch",
      sourceKind: "images",
      suggestedWorkTitle: "Context migration fixture",
      chapters: drafts,
    },
    target: { mode: "new", title: "Context migration fixture" },
    selections: drafts.map(({ draftId, title }) => ({
      draftId,
      title,
      enabled: true,
    })),
  });
  const chapterId = imported.chapterIds[0];
  const first = await library.openChapter(chapterId);
  const guide = await library.getWorkStyleGuide(first.workId);
  guide.characters = ["migration-source", "migration-target"].map((id) => ({
    id,
    displayName: id,
    sourceNames: [],
    targetName: id,
    speechStyle: "neutral",
    enabled: true,
    origin: "ai",
    createdAt: "initial",
    updatedAt: "initial",
  }));
  await library.saveWorkStyleGuide(guide);
  for (const id of imported.chapterIds) {
    const page = (await library.openChapter(id)).pages[0];
    await library.savePageBlocks({
      chapterId: id,
      pageId: page.id,
      blocks: [
        {
          ...source.blocks[0],
          id: randomUUID(),
          speakerId: "migration-source",
        },
      ],
    });
  }
  const memory = await library.getChapterStoryMemory(imported.chapterIds[1]);
  memory.pages = [
    {
      pageId: "orphan-memory",
      pageName: "fixture",
      pageIndex: 9,
      sourceDigest: "source excerpt",
      translatedDigest: "translation excerpt",
      summary: "Preserve this actual story excerpt",
      characterIds: ["migration-source"],
      updatedAt: "initial",
    },
  ];
  await library.saveChapterStoryMemory(memory);
  return chapterId;
}

/** Real Electron encryption, native publication and reconstruction; no model or public connection.
 * @param {string} root @param {NativeApp} app @param {Editing} editing @param {string} sourceChapterId */
async function checkNativeContextMigration(
  root,
  app,
  editing,
  sourceChapterId,
) {
  const { readWorkContextReferences } = require(
    join(root, "out/main/library/libraryContextEditingFacade.js"),
  );
  const chapterId = await seedContextWork(root, sourceChapterId);
  /** @returns {Promise<Graph>} */
  const graph = () => readWorkContextReferences(chapterId, () => {});
  const before = await graph();
  const originals = await Promise.all(
    before.chapters.map(({ chapter }) => readFile(chapter.pages[0].imagePath)),
  );
  let client = await retainedClient(root, app, editing);
  try {
    const references = await client.call("get_context_references", {
      chapterId,
    });
    const intent = {
      chapterId,
      referenceSnapshot: references.snapshot,
      command: {
        kind: "merge",
        entity: "character",
        sourceIds: ["migration-source"],
        targetId: "migration-target",
      },
    };
    const preview = await client.call("preview_context_migration", intent);
    const input = {
      ...intent,
      planFingerprint: preview.planFingerprint,
      requestId: randomUUID(),
    };
    const applied = await client.call("apply_context_migration", input);
    assert.equal(applied.status, "saved");
    assert.deepEqual(applied.changes, {
      guideChanged: true,
      pages: 2,
      blocks: 2,
      memories: 1,
    });
    const after = await graph();
    for (const item of after.chapters)
      assert.equal(
        item.chapter.pages[0].blocks[0].speakerId,
        "migration-target",
      );
    assert.deepEqual(after.chapters[1].storyMemory.pages[0].characterIds, [
      "migration-target",
    ]);
    await client.close();
    client = await retainedClient(root, app, editing);
    for (const direction of ["undo", "redo", "undo"]) {
      await recoverContext(client, applied.id, direction);
      assertContextEqual(await graph(), direction === "undo" ? before : after);
    }
    await client.close();
    client = await retainedClient(root, app, editing);
    assert.equal(
      (await client.call("apply_context_migration", input)).status,
      "already_applied",
    );
    assertContextEqual(await graph(), before);
    await client.call("discard_retained", { id: applied.id, confirm: true });
    await assert.rejects(() =>
      client.call("get_context_migration", { id: applied.id }),
    );
    for (const [index, item] of before.chapters.entries())
      assert.deepEqual(
        await readFile(item.chapter.pages[0].imagePath),
        originals[index],
      );
    await checkNativeMemoryRefresh(root, app, editing, chapterId);
    await checkNativeResearchProposal(root, app, editing, chapterId);
    console.log(
      "PASS native OS-encrypted whole-work context migration -> reconstructed exact reference/memory undo/redo -> historical replay -> retained discard; originals preserved",
    );
  } finally {
    await client.close();
  }
}

/** @param {Client} client @param {string} id @param {string} direction */
async function recoverContext(client, id, direction) {
  const state = await client.call("get_context_migration", { id });
  assert.equal(direction === "undo" ? state.canUndo : state.canRedo, true);
  const result = await client.call(`${direction}_context_migration`, {
    id,
    requestId: randomUUID(),
    referenceSnapshot: state.referenceSnapshot,
  });
  assert.equal(result.status, "saved");
}

/** @param {Graph} actual @param {Graph} expected */
function assertContextEqual(actual, expected) {
  assert.deepEqual(actual.styleGuide, expected.styleGuide);
  assert.equal(actual.chapters.length, expected.chapters.length);
  for (const [index, item] of actual.chapters.entries()) {
    assert.deepEqual(
      item.chapter.pages.map((page) => page.blocks),
      expected.chapters[index].chapter.pages.map((page) => page.blocks),
    );
    assert.deepEqual(
      item.storyMemory.pages,
      expected.chapters[index].storyMemory.pages,
    );
  }
}

/** @param {string} root @param {NativeApp} app @param {Editing} editing @param {string} chapterId */
async function checkNativeMemoryRefresh(root, app, editing, chapterId) {
  const library = require(join(root, "out/main/library.js"));
  const { getWorksRoot } = require(
    join(root, "out/main/libraryStore/libraryPaths.js"),
  );
  const page = (await library.openChapter(chapterId)).pages[0];
  const memory = await library.getChapterStoryMemory(chapterId);
  const path = join(
    getWorksRoot(),
    memory.workId,
    "chapters",
    chapterId,
    "story-memory.json",
  );
  await assert.rejects(() => stat(path), { code: "ENOENT" });
  const original = await readFile(page.imagePath);
  let client = await retainedClient(root, app, editing);
  try {
    const status = await client.call("get_memory_status", { chapterId });
    const row = status.items.find(
      (/** @type {{chapterId:string,pageId:string}} */ item) =>
        item.chapterId === chapterId && item.pageId === page.id,
    );
    assert.ok(row);
    assert.equal(row.status, "missing");
    const intent = {
      chapterId,
      referenceSnapshot: status.referenceSnapshot,
      pages: [
        {
          chapterId,
          pageId: page.id,
          revision: row.revision,
          sourceFingerprint: row.sourceFingerprint,
          translationFingerprint: row.translationFingerprint,
          summary: { kind: "native-excerpt" },
        },
      ],
    };
    const preview = await client.call("preview_memory_refresh", intent);
    await assert.rejects(() => stat(path), { code: "ENOENT" });
    const input = {
      ...intent,
      planFingerprint: preview.planFingerprint,
      requestId: randomUUID(),
    };
    const applied = await client.call("apply_memory_refresh", input);
    assert.equal(applied.status, "saved");
    const saved = await library.getChapterStoryMemory(chapterId);
    assert.equal(saved.pages[0].textEvidence.method, "native-excerpt");
    assert.equal(
      (await client.call("get_memory_status", { chapterId })).counts.current,
      1,
    );
    await client.close();
    client = await retainedClient(root, app, editing);
    await recoverContext(client, applied.id, "undo");
    await assert.rejects(() => stat(path), { code: "ENOENT" });
    assert.equal(
      (await client.call("apply_memory_refresh", input)).status,
      "already_applied",
    );
    await assert.rejects(() => stat(path), { code: "ENOENT" });
    await recoverContext(client, applied.id, "redo");
    assert.deepEqual(await library.getChapterStoryMemory(chapterId), saved);
    await recoverContext(client, applied.id, "undo");
    await client.call("discard_retained", { id: applied.id, confirm: true });
    await assert.rejects(() => stat(path), { code: "ENOENT" });
    assert.deepEqual(await readFile(page.imagePath), original);
    assert.deepEqual(
      (await library.openChapter(chapterId)).pages[0].blocks,
      page.blocks,
    );
    console.log(
      "PASS native memory full-text evidence -> explicit refresh -> OS-encrypted restart undo/redo -> exact missing-file restoration; original text and pixels preserved",
    );
  } finally {
    await client.close();
  }
}

module.exports = { checkNativeContextMigration };
