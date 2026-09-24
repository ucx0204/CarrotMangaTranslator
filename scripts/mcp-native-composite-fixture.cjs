const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { sendNativeFile } = require("./mcp-native-incoming-files.cjs");
const {
  compositeNoModelBudget,
  executeCompositePhase,
} = require("./mcp-native-composite-phases.cjs");
const {
  assertCompositeImportPublication,
} = require("./mcp-native-composite-proof.cjs");

/** @typedef {import("./mcp-native-composite-client.cjs").Client} Client */
/** @typedef {import("./mcp-native-composite-client.cjs").NativeApp} NativeApp */
/** @typedef {import("./mcp-native-composite-phases.cjs").Parent} Parent */

/** @param {string} root @param {Client} client @param {string} packagePath */
async function prepareCompositeImport(root, client, packagePath) {
  const library = require(join(root, "out/main/library.js"));
  const bytes = await readFile(packagePath),
    before = await library.listLibrary();
  const upload = await sendNativeFile(
    client,
    bytes,
    "Composite-fixture.mgtshare",
  );
  const preview = await client.call("preview_work_file", {
    uploadId: upload.uploadId,
  });
  const chapter = preview.chapters[0];
  assert.ok(chapter && chapter.pageCount >= 1 && chapter.pageCount <= 2);
  /** @type {import("../src/shared/mcpCompositeWorkflowActions").McpCompositeImportAction} */
  const action = {
    kind: "work-file-import",
    input: {
      requestId: randomUUID(),
      uploadId: upload.uploadId,
      snapshot: preview.snapshot,
      chapters: [
        {
          packageChapterId: chapter.packageChapterId,
          title: "Composite imported pages",
        },
      ],
      target: { mode: "new", title: "Native composite isolated work" },
      allowNativePreparation: true,
      acknowledgeV1Limitations: true,
    },
  };
  const envelope = await client.call("preflight_composite_import", {
    phaseId: "import",
    action,
  });
  assert.equal(envelope.itemKeys.length, chapter.pageCount);
  const parent = await client.call("prepare_composite", {
    requestId: randomUUID(),
    reason: "Isolated real Electron zero-model composite acceptance",
    targets: envelope,
    phases: [
      { kind: "native", id: "import", action: "work-file-import" },
      { kind: "native", id: "context", action: "context-apply" },
      { kind: "native", id: "text", action: "text-export" },
      { kind: "review", id: "review" },
      { kind: "native", id: "images", action: "images-export" },
      { kind: "native", id: "zip", action: "zip-export" },
      { kind: "native", id: "working-file", action: "work-file-export" },
    ],
    maxReviewPasses: 1,
    budgets: compositeNoModelBudget(7, 2),
  });
  assert.deepEqual(parent.targets, []);
  assert.equal(parent.used.admissions, 0);
  assert.deepEqual(await library.listLibrary(), before);
  assert.ok((await readFile(packagePath)).equals(bytes));
  return { parent, action, envelope, bytes, uploadId: upload.uploadId, before };
}
/** @param {string} root @param {Client} client @param {Awaited<ReturnType<typeof prepareCompositeImport>>} prepared */
async function importCompositePages(root, client, prepared) {
  const parent = await executeCompositePhase(
    client,
    prepared.parent,
    "import",
    prepared.action,
  );
  const imported = parent.phases[0].outcome?.imported;
  assert.ok(imported);
  assert.equal(
    imported.selectionFingerprint,
    prepared.envelope.selectionFingerprint,
  );
  assert.deepEqual(
    imported.items.map((/** @type {{itemKey:string}} */ item) => item.itemKey),
    prepared.envelope.itemKeys,
  );
  assert.deepEqual(
    imported.items.map(
      (/** @type {{page:Parent["targets"][number]}} */ item) => item.page,
    ),
    parent.targets,
  );
  assert.equal(
    new Set(
      parent.targets.map(
        (/** @type {Parent["targets"][number]} */ page) =>
          `${page.chapterId}/${page.pageId}`,
      ),
    ).size,
    parent.targets.length,
  );
  const library = require(join(root, "out/main/library.js"));
  const chapter = await library.openChapter(parent.targets[0].chapterId);
  assert.deepEqual(
    parent.targets.map(
      (/** @type {Parent["targets"][number]} */ page) => page.pageId,
    ),
    chapter.pageOrder,
  );
  assert.ok(
    parent.targets.every(
      (/** @type {Parent["targets"][number]} */ page) =>
        page.workId === chapter.workId &&
        page.chapterId === chapter.id &&
        page.blockIds.length === 0,
    ),
  );
  assert.equal(
    (await library.listLibrary()).works.length,
    prepared.before.works.length + 1,
  );
  await assertCompositeImportPublication(
    root,
    client,
    prepared.action.input.requestId,
    parent,
  );
  await client.call("discard_file_upload", { uploadId: prepared.uploadId });
  return { parent, chapter };
}
/** The actual empty-editor handoff, restricted to this newly imported chapter.
 * @param {NativeApp} app @param {string} chapterId */
function compositeFixtureHandoffs(app, chapterId) {
  /** @type {Set<string>} */
  const blocked = new Set();
  /** @type {((jobId:string)=>void) | undefined} */
  let cancellation;
  const stop = app.jobs.pageHandoffs.subscribe(() => {
    for (const page of app.jobs.pageHandoffs.activities) {
      if (
        page.chapterId !== chapterId ||
        page.phase !== "finishing-edits" ||
        !page.requestId ||
        blocked.has(page.jobId)
      )
        continue;
      if (cancellation) {
        const notify = cancellation;
        cancellation = undefined;
        blocked.add(page.jobId);
        notify(page.jobId);
      } else app.jobs.pageHandoffs.respond({ requestId: page.requestId });
    }
  });
  return {
    stop,
    cancelNext: (/** @type {(jobId:string)=>void} */ notify) => {
      cancellation = notify;
    },
  };
}
/** @param {string} root @param {Client} client @param {Parent} parent */
async function applyCompositeContext(root, client, parent) {
  const library = require(join(root, "out/main/library.js"));
  const chapterId = parent.targets[0].chapterId,
    workId = parent.targets[0].workId;
  const before = await library.getWorkStyleGuide(workId);
  const current = await client.call("get_work_context", { chapterId });
  const proposal = await client.call("preview_context_edit", {
    chapterId,
    revision: current.revision,
    requestId: randomUUID(),
    changes: [
      {
        changeId: "chosen-term",
        entity: "glossary",
        values: {
          source: "Composite fixture term",
          target: "명시적 선택",
          category: "term",
          enabled: true,
        },
      },
      {
        changeId: "unchosen-rule",
        entity: "rules",
        values: {
          honorifics: before.rules.honorifics === "drop" ? "preserve" : "drop",
        },
      },
    ],
  });
  const result = await executeCompositePhase(client, parent, "context", {
    kind: "context-apply",
    input: {
      proposalId: proposal.proposalId,
      requestId: randomUUID(),
      selectedChangeIds: ["chosen-term"],
    },
  });
  const after = await library.getWorkStyleGuide(workId);
  assert.deepEqual(after.rules, before.rules);
  assert.equal(after.glossary.length, before.glossary.length + 1);
  assert.ok(
    after.glossary.some(
      (/** @type {{source:string,target:string}} */ entry) =>
        entry.source === "Composite fixture term" &&
        entry.target === "명시적 선택",
    ),
  );
  return result;
}
module.exports = {
  prepareCompositeImport,
  importCompositePages,
  compositeFixtureHandoffs,
  applyCompositeContext,
};
