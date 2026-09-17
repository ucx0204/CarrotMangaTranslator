const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

/** @param {string} root @param {string} name */
function load(root, name) {
  return require(join(root, "out", name));
}

/** Exercises production tools/storage in the disposable native library only.
 * Research evidence is synthetic caller data: no search/model invocation.
 * @param {string} root
 * @param {(name: string, args: object) => Promise<Array<{type?: string, text?: string}>>} invoke
 * @param {string} chapterId @param {string} pageId */
async function checkNativeContext(root, invoke, chapterId, pageId) {
  const library = load(root, "main/library.js");
  const { mcpContextRevision } = load(root, "shared/mcpContextEditing.js");
  const { createPageRevision } = load(root, "shared/pageRevision.js");
  /** @param {string} name @param {object} args */
  const call = async (name, args) => {
    const content = await invoke(name, args);
    assert.equal(content.length, 1, "Context operations return metadata only");
    assert.equal(content[0].type, "text");
    assert.ok(content[0].text);
    return JSON.parse(content[0].text);
  };
  const before = await library.readWorkContextForEdit(chapterId);
  const page = before.chapter.pages.find(
    (/** @type {{id: string}} */ item) => item.id === pageId,
  );
  assert.ok(page);
  const original = await readFile(page.imagePath);
  const revision = mcpContextRevision(before);
  const request = {
    chapterId,
    revision,
    requestId: randomUUID(),
    changes: [
      {
        changeId: "g",
        entity: "glossary",
        values: {
          source: "Native hero",
          target: "Hero",
          aliases: ["Keep alias"],
          note: "Keep note",
        },
      },
      {
        changeId: "c",
        entity: "character",
        values: {
          displayName: "Native character",
          targetName: "Character",
          speechStyle: "polite",
        },
      },
      {
        changeId: "r",
        entity: "rules",
        values: {
          sfxMode:
            before.styleGuide.rules.sfxMode === "note" ? "translate" : "note",
        },
      },
      {
        changeId: "m",
        entity: "memory",
        pageId,
        pageRevision: createPageRevision(page),
        values: { summary: "Explicit user memory, not internet evidence." },
      },
    ],
  };
  const proposal = await call("carrot_preview_context_edit", request);
  assert.equal(
    (await call("carrot_preview_context_edit", request)).proposalId,
    proposal.proposalId,
  );
  assert.deepEqual(await library.readWorkContextForEdit(chapterId), before);
  const review = await call("carrot_get_context_proposal", {
    proposalId: proposal.proposalId,
  });
  assert.equal(review.total, 4);
  const apply = {
    proposalId: proposal.proposalId,
    requestId: randomUUID(),
    selectedChangeIds: ["g", "c", "r", "m"],
  };
  assert.equal(
    (await call("carrot_apply_context_proposal", apply)).changesApplied,
    4,
  );
  const changed = await library.readWorkContextForEdit(chapterId);
  assert.deepEqual(changed.chapter, before.chapter);
  assert.deepEqual(
    changed.styleGuide.glossary.slice(0, -1),
    before.styleGuide.glossary,
  );
  assert.deepEqual(
    changed.styleGuide.characters.slice(0, -1),
    before.styleGuide.characters,
  );
  assert.deepEqual(await readFile(page.imagePath), original);
  assert.equal(
    (await call("carrot_apply_context_proposal", apply)).status,
    "already_applied",
  );
  assert.deepEqual(await library.readWorkContextForEdit(chapterId), changed);
  await assert.rejects(() =>
    call("carrot_preview_context_edit", {
      ...request,
      requestId: randomUUID(),
    }),
  );
  await checkExternalSelection(
    call,
    chapterId,
    changed,
    library,
    mcpContextRevision,
  );
  const final = await library.readWorkContextForEdit(chapterId);
  assert.deepEqual(final.chapter, before.chapter);
  assert.deepEqual(final.storyMemory, changed.storyMemory);
  assert.deepEqual(await readFile(page.imagePath), original);
  console.log(
    "PASS native glossary/character/rules/memory preview -> atomic apply -> exact retry; original page unchanged",
  );
  console.log(
    "PASS native external research provenance, selected changes, preserved optional fields and stale proposal rejection",
  );
}

/** @param {(name: string, args: object) => Promise<any>} call
 * @param {string} chapterId @param {any} snapshot @param {any} library
 * @param {(snapshot: any) => string} revisionOf */
async function checkExternalSelection(
  call,
  chapterId,
  snapshot,
  library,
  revisionOf,
) {
  const glossary = snapshot.styleGuide.glossary.at(-1);
  const character = snapshot.styleGuide.characters.at(-1);
  assert.ok(glossary && character);
  const source = {
    title: "Synthetic reference (not fetched)",
    url: "https://example.com/native-context-reference",
  };
  const proposal = await call("carrot_preview_context_research", {
    chapterId,
    revision: revisionOf(snapshot),
    requestId: randomUUID(),
    changes: [
      {
        change: {
          changeId: "g",
          entity: "glossary",
          entryId: glossary.id,
          values: { target: "Reviewed hero" },
        },
        reason: "Synthetic test evidence",
        sources: [source],
      },
      {
        change: {
          changeId: "c",
          entity: "character",
          entryId: character.id,
          values: { targetName: "Do not apply" },
        },
        reason: "Unselected test evidence",
        sources: [source],
      },
    ],
  });
  assert.equal(proposal.source, "external-research");
  assert.ok(
    proposal.warnings.some((/** @type {string} */ warning) =>
      warning.includes("not fetched or verified"),
    ),
  );
  const review = await call("carrot_get_context_proposal", {
    proposalId: proposal.proposalId,
    limit: 1,
  });
  assert.equal(review.nextOffset, 1);
  assert.deepEqual(review.changes[0].sources, [source]);
  const second = await call("carrot_get_context_proposal", {
    proposalId: proposal.proposalId,
    offset: 1,
    limit: 1,
  });
  assert.equal(second.changes[0].changeId, "c");
  const applying = {
    proposalId: proposal.proposalId,
    requestId: randomUUID(),
    selectedChangeIds: ["g"],
  };
  const stale = await call("carrot_preview_context_edit", {
    chapterId,
    revision: revisionOf(snapshot),
    requestId: randomUUID(),
    changes: [
      { changeId: "r", entity: "rules", values: { honorifics: "drop" } },
    ],
  });
  await call("carrot_apply_context_proposal", applying);
  const after = await library.readWorkContextForEdit(chapterId);
  assert.deepEqual(after.styleGuide.characters, snapshot.styleGuide.characters);
  assert.deepEqual(after.styleGuide.rules, snapshot.styleGuide.rules);
  const updated = after.styleGuide.glossary.at(-1);
  assert.equal(updated.target, "Reviewed hero");
  assert.equal(updated.origin, glossary.origin);
  assert.equal(updated.note, glossary.note);
  assert.deepEqual(updated.aliases, glossary.aliases);
  await assert.rejects(() =>
    call("carrot_apply_context_proposal", {
      proposalId: stale.proposalId,
      requestId: randomUUID(),
      selectedChangeIds: ["r"],
    }),
  );
  assert.equal(
    (await call("carrot_apply_context_proposal", applying)).status,
    "already_applied",
  );
  assert.deepEqual(await library.readWorkContextForEdit(chapterId), after);
}

module.exports = { checkNativeContext };
