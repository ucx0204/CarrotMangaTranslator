const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const {
  compositeNativeClient,
  downloadCompositeFile,
} = require("./mcp-native-composite-client.cjs");
const {
  compositeMutation,
  bindCompositePhase,
  runCompositePhase,
} = require("./mcp-native-composite-phases.cjs");
const {
  prepareCompositeControl,
} = require("./mcp-native-composite-controls.cjs");

/** @typedef {import("./mcp-native-composite-client.cjs").Client} Client */
/** @typedef {import("./mcp-native-composite-phases.cjs").Parent} Parent */
/** @typedef {ReturnType<typeof import("./mcp-native-exchange-client.cjs").observeExchangeWork>} Observation */
/** @typedef {{client:Client}} Live */

/** @param {string} root @param {import("./mcp-native-composite-client.cjs").NativeApp} app
 * @param {import("./mcp-native-composite-client.cjs").Editing} editing @param {Live} live @param {Observation} observed */
async function restartCompositeClient(root, app, editing, live, observed) {
  const credentials = live.client.credentials,
    jobs = observed.jobs.size,
    windows = observed.windows();
  assert.deepEqual(live.client.errors, []);
  await live.client.close();
  live.client = await compositeNativeClient(root, app, editing, {
    credentials,
  });
  assert.equal(live.client.credentials.connectionId, credentials.connectionId);
  assert.equal(observed.jobs.size, jobs);
  assert.equal(observed.windows(), windows);
}
/** @param {Client} client @param {Parent} parent
 * @param {Awaited<ReturnType<typeof import("./mcp-native-composite-outputs.cjs").exportCompositeZip>>} zip
 * @param {Observation} observed */
async function reissueCompositeZip(client, parent, zip, observed) {
  const jobs = observed.jobs.size,
    windows = observed.windows();
  const historical = await client.call("get_composite", { id: parent.id });
  assert.equal(historical.status, "completed");
  assert.equal(historical.automaticResume, false);
  assert.deepEqual(historical.phases, parent.phases);
  assert.deepEqual(historical.used, parent.used);
  const review = await client.call("get_composite_review", {
    id: parent.id,
    phaseId: "review",
  });
  for (const evidence of review.evidence)
    await client.denied("get_composite_review_image", {
      id: parent.id,
      phaseId: "review",
      evidenceId: evidence.id,
    });
  const fresh = await client.call("get_output_file", {
    id: zip.file.retainedOutputId,
  });
  assert.notEqual(fresh.url, zip.file.url);
  assert.equal(fresh.sha256, zip.file.sha256);
  assert.ok((await downloadCompositeFile(client, fresh)).equals(zip.bytes));
  assert.equal(observed.jobs.size, jobs);
  assert.equal(observed.windows(), windows);
}
/** @param {string} root @param {import("./mcp-native-composite-client.cjs").NativeApp} app
 * @param {import("./mcp-native-composite-client.cjs").Editing} editing @param {Live} live
 * @param {Parent["targets"]} targets @param {Observation} observed */
async function requireCompositeRebindAfterRestart(
  root,
  app,
  editing,
  live,
  targets,
  observed,
) {
  const parent = await prepareCompositeControl(live.client, targets, [
    { kind: "native", id: "restart-text", action: "text-export", role: "work" },
  ]);
  const preview = await live.client.call("preflight_text_export", {
    chapterId: targets[0].chapterId,
    pageIds: targets.map((page) => page.pageId),
    options: { format: "txt", field: "translated", includeHeaders: true },
  });
  /** @type {import("../src/shared/mcpCompositeWorkflowActions").McpCompositeWorkflowAction} */
  const action = {
    kind: "text-export",
    input: { binding: preview.binding, requestId: randomUUID() },
  };
  const bound = await bindCompositePhase(
    live.client,
    parent,
    "restart-text",
    action,
  );
  const { parseMcpJobJournal } = require(
    join(root, "out/main/application/mcpJobJournal.js"),
  );
  const journalBefore = compositeJournalIdentities(
    parseMcpJobJournal(await live.client.journal()),
  );
  await restartCompositeClient(root, app, editing, live, observed);
  const saved = await live.client.call("get_composite", { id: bound.id });
  assert.equal(saved.phases[0].status, "bound");
  assert.equal(saved.used.admissions, 0);
  await live.client.denied("run_composite", compositeMutation(saved));
  assert.deepEqual(
    compositeJournalIdentities(parseMcpJobJournal(await live.client.journal())),
    journalBefore,
  );
  const current = await live.client.call("get_composite", { id: saved.id });
  assert.equal(current.used.admissions, 0);
  const settled = await runCompositePhase(
    live.client,
    await bindCompositePhase(live.client, current, "restart-text", action),
  );
  assert.equal(settled.status, "completed");
  assert.equal(settled.used.admissions, 1);
}
/** Expired artifact/proposal metadata may legitimately change during reconstruction.
 * @param {import("../src/main/application/mcpJobJournal").McpStoredJob[]} records */
function compositeJournalIdentities(records) {
  return records.map(
    ({ id, owner, requestId, kind, status, startedAt, finishedAt }) => ({
      id,
      owner,
      requestId,
      kind,
      status,
      startedAt,
      finishedAt,
    }),
  );
}
module.exports = {
  restartCompositeClient,
  reissueCompositeZip,
  requireCompositeRebindAfterRestart,
};
