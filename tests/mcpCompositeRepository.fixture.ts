import { randomUUID } from "node:crypto";
import type {
  McpCompositeOutcome,
  McpCompositeRecord,
} from "../src/main/application/mcpCompositeWorkflowPorts";
import {
  compositeFingerprint,
  reserveCompositeCost,
  zeroCompositeCost,
} from "../src/main/application/mcpCompositeWorkflowPolicy";
import { parseCompositeRecord } from "../src/main/application/mcpCompositeWorkflowRecord";
import { McpCompositePrepareSchema } from "../src/shared/mcpCompositeWorkflow";
import type { McpCompositeRenderEvidence } from "../src/shared/mcpCompositeWorkflowReview";

export const compositeOwner = "composite-owner";
export const compositeDigest = "a".repeat(64);
export const compositePage = {
  workId: "work",
  chapterId: "chapter",
  pageId: "page",
  blockIds: ["block"],
};
export function compositeSnapshot(pages = [compositePage]) {
  return {
    fingerprint: compositeFingerprint(pages),
    policyFingerprint: compositeDigest,
    pages: pages.map((page) => ({
      ...page,
      revision: "page-v1:" + "b".repeat(16),
      reviewRevision: "page-v1:" + "c".repeat(16),
      sourceFingerprint: compositeDigest,
      contextFingerprint: compositeDigest,
      settingsFingerprint: compositeDigest,
      fontFingerprint: compositeDigest,
      membershipFingerprint: compositeDigest,
      memoryFingerprint: compositeDigest,
    })),
  };
}
export function newCompositeRecord(imported = false, twoPhases = false) {
  const now = Date.now();
  const phases = [
    {
      kind: "native" as const,
      id: "first",
      action: imported ? ("import-create" as const) : ("workflow-run" as const),
      role: "work" as const,
    },
  ];
  if (twoPhases)
    phases.push({
      kind: "native",
      id: "second",
      action: "workflow-run",
      role: "work",
    });
  const targets = imported ? [] : [compositePage];
  const plan = McpCompositePrepareSchema.parse({
    requestId: randomUUID(),
    reason: "Bounded composite persistence",
    targets: imported
      ? {
          kind: "reviewed-import",
          phaseId: "first",
          selectionFingerprint: compositeDigest,
          itemKeys: [compositeDigest],
          maxChapters: 1,
          maxPages: 1,
        }
      : { kind: "saved", pages: targets },
    phases,
    maxReviewPasses: 1,
    budgets: {
      admissions: 8,
      pageAttempts: 8,
      translationRequests: 0,
      researchAttempts: 0,
      selectedEdits: 8,
      models: zeroCompositeCost().models,
    },
  });
  return parseCompositeRecord({
    format: 1,
    kind: "composite-workflow",
    id: randomUUID(),
    owner: compositeOwner,
    version: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 7 * 24 * 60 * 60_000,
    plan,
    initialFingerprint: compositeFingerprint(plan),
    status: "prepared",
    snapshot: compositeSnapshot(targets),
    targets,
    phases: plan.phases.map(({ id }) => ({ id, status: "unbound" })),
    used: zeroCompositeCost(),
    usageUnknown: false,
    reviewPairs: [],
    actions: [],
  });
}
export function compositeBound(current: McpCompositeRecord, index = 0) {
  const record = structuredClone(current);
  const descriptor = record.plan.phases[index];
  if (descriptor.kind !== "native")
    throw new Error("Fixture needs a native phase.");
  const nativeRequestId = randomUUID();
  record.version += 1;
  record.updatedAt = Date.now();
  record.phases[index] = {
    id: descriptor.id,
    status: "bound",
    binding: {
      owner: record.owner,
      compositeId: record.id,
      phaseId: descriptor.id,
      family: descriptor.action,
      inputFingerprint: compositeFingerprint({ nativeRequestId }),
      nativeRequestId,
      nativeReference: {
        requestId: nativeRequestId,
        kind: descriptor.action,
        fingerprint: "b".repeat(16),
      },
      snapshot: structuredClone(record.snapshot),
      predecessorReceipts: record.phases.flatMap((phase) =>
        phase.outcome ? [phase.outcome.receipt] : [],
      ),
      cost: {
        ...zeroCompositeCost(),
        admissions: 1,
        pageAttempts: Math.max(1, record.targets.length),
      },
    },
  };
  record.actions.push({
    requestId: randomUUID(),
    fingerprint: compositeFingerprint(["bind", descriptor.id]),
  });
  return parseCompositeRecord(record);
}
export function compositeReserved(current: McpCompositeRecord, index = 0) {
  const record = structuredClone(current);
  const phase = record.phases[index];
  if (!phase.binding) throw new Error("Fixture needs an explicit binding.");
  reserveCompositeCost(record, phase.binding.cost);
  phase.status = "running";
  phase.attemptId = randomUUID();
  record.status = "running";
  record.version += 1;
  record.updatedAt = Date.now();
  delete record.stopReason;
  record.actions.push({
    requestId: randomUUID(),
    fingerprint: compositeFingerprint(["run", phase.id]),
  });
  return parseCompositeRecord(record);
}
export function compositeOutcome(
  record: McpCompositeRecord,
  status: McpCompositeOutcome["status"] = "completed",
  index = 0,
): McpCompositeOutcome {
  const binding = record.phases[index].binding;
  if (!binding) throw new Error("Fixture needs a binding.");
  return {
    status,
    receipt: {
      kind: binding.family === "import-create" ? "import" : "workflow",
      id: randomUUID(),
      requestId: binding.nativeRequestId,
      family: binding.family,
      inputFingerprint: binding.inputFingerprint,
    },
    resultFingerprint: compositeFingerprint({
      status,
      requestId: binding.nativeRequestId,
    }),
    ...(binding.family === "import-create"
      ? {
          imported: {
            selectionFingerprint: compositeDigest,
            items: [{ itemKey: compositeDigest, page: compositePage }],
          },
        }
      : {}),
  };
}
export function compositeEvidence(
  record: McpCompositeRecord,
  index = 0,
  pass = 1,
): McpCompositeRenderEvidence {
  const {
    blockIds: _blocks,
    membershipFingerprint: _membership,
    memoryFingerprint: _memory,
    ...page
  } = record.snapshot.pages[0];
  return {
    ...page,
    id: randomUUID(),
    owner: record.owner,
    compositeId: record.id,
    phaseId: record.phases[index].id,
    pass,
    kind: "rendered-page",
    sha256: compositeDigest,
    width: 1,
    height: 1,
    pixelMapping: { originX: 0, originY: 0, scaleX: 1, scaleY: 1 },
    fontEvidence: {
      appManaged: "bytes-sha256",
      systemFallback: "native-render-pixels-only",
    },
    renderOptionsFingerprint: compositeDigest,
    createdAt: record.createdAt,
  };
}
