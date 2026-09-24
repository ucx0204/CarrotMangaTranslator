const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { waitComposite } = require("./mcp-native-composite-client.cjs");

/** @typedef {import("./mcp-native-composite-client.cjs").Client} Client */
/** @typedef {ReturnType<typeof import("../src/shared/mcpCompositeWorkflowOutputs").McpCompositeViewSchema.parse>} Parent */
/** @typedef {import("../src/shared/mcpCompositeWorkflowActions").McpCompositeWorkflowAction} Action */

/** @param {Parent} parent */
function compositeMutation(parent) {
  return { id: parent.id, version: parent.version, requestId: randomUUID() };
}
/** @param {Client} client @param {Parent} parent @param {string} phaseId @param {Action} action */
async function bindCompositePhase(client, parent, phaseId, action) {
  return client.call("bind_composite", {
    ...compositeMutation(parent),
    phaseId,
    action,
    expectedSnapshot: parent.snapshot,
    predecessorReceipts: parent.phases.flatMap((phase) =>
      phase.child ? [phase.child] : [],
    ),
  });
}
/** Explicitly runs exactly one phase, then checks replay against its original command.
 * @param {Client} client @param {Parent} bound */
async function runCompositePhase(client, bound) {
  const command = compositeMutation(bound);
  await client.call("run_composite", command);
  const settled = await waitComposite(client, bound.id);
  assert.notEqual(settled.status, "held", JSON.stringify(settled));
  assert.notEqual(settled.status, "cancelled", JSON.stringify(settled));
  const replay = await client.call("run_composite", command);
  assert.deepEqual(
    replay.used,
    settled.used,
    "Exact parent run replay cannot recharge native usage",
  );
  assert.deepEqual(
    replay.phases,
    settled.phases,
    "Exact parent run replay cannot replace the owned child",
  );
  assert.equal(replay.automaticResume, false);
  assert.ok(Object.values(replay.used.models).every((value) => value === 0));
  return replay;
}
/** @param {Client} client @param {Parent} parent @param {string} phaseId @param {Action} action */
async function executeCompositePhase(client, parent, phaseId, action) {
  return runCompositePhase(
    client,
    await bindCompositePhase(client, parent, phaseId, action),
  );
}
/** @param {Parent} parent @param {string} phaseId */
function compositeChild(parent, phaseId) {
  const phase = parent.phases.find((entry) => entry.descriptor.id === phaseId);
  assert.ok(phase);
  assert.equal(phase.status, "completed");
  assert.ok(phase.child);
  assert.equal(phase.outcome?.status, "completed");
  assert.deepEqual(phase.child, phase.outcome.receipt);
  return phase.child;
}
/** @param {Client} client */
async function assertCompositeRegistration(client) {
  const { tools } = await client.listTools();
  const expected = [
    "preflight_composite_import",
    "prepare_composite",
    "bind_composite",
    "run_composite",
    "resume_composite",
    "get_composite",
    "list_composites",
    "pause_composite",
    "cancel_composite",
    "reconcile_composite",
    "discard_composite",
    "submit_composite_review",
    "get_composite_review",
    "get_composite_review_image",
    "get_composite_native_review",
  ];
  for (const name of expected)
    assert.equal(
      tools.filter(
        (/** @type {{name:string}} */ tool) => tool.name === `carrot_${name}`,
      ).length,
      1,
    );
  for (const name of [
    "prepare_workflow",
    "run_workflow",
    "resume_workflow",
    "get_workflow",
    "list_workflows",
    "pause_workflow",
    "cancel_workflow",
    "discard_workflow",
    "accept_workflow_external",
    "get_workflow_handoff_identity",
    "offer_workflow_handoff",
    "accept_workflow_handoff",
    "revoke_workflow_handoff",
    "get_job",
    "get_output_file",
    "export_text_file",
  ])
    assert.equal(
      tools.filter(
        (/** @type {{name:string}} */ tool) => tool.name === `carrot_${name}`,
      ).length,
      1,
    );
}
/** @param {number} admissions @param {number} pages */
function compositeNoModelBudget(admissions, pages) {
  return {
    admissions,
    pageAttempts: admissions * pages,
    translationRequests: 0,
    researchAttempts: 0,
    selectedEdits: 2,
    models: {
      ocr: 0,
      translation: 0,
      erase: 0,
      research: 0,
      typography: 0,
      soundEffect: 0,
    },
  };
}
module.exports = {
  compositeMutation,
  bindCompositePhase,
  runCompositePhase,
  executeCompositePhase,
  compositeChild,
  assertCompositeRegistration,
  compositeNoModelBudget,
};
