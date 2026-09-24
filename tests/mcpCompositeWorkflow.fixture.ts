import { randomUUID } from "node:crypto";
import { McpCompositePrepareSchema } from "../src/shared/mcpCompositeWorkflow";
import type {
  McpCompositeBind,
  McpCompositeChildReference,
} from "../src/shared/mcpCompositeWorkflow";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import { McpCompositeWorkflowService } from "../src/main/application/mcpCompositeWorkflowService";
import {
  compositeFingerprint,
  compositePredecessors,
  nextCompositePhase,
  zeroCompositeCost,
} from "../src/main/application/mcpCompositeWorkflowPolicy";
import { parseCompositeRecord } from "../src/main/application/mcpCompositeWorkflowRecord";
import type {
  McpCompositeBinding,
  McpCompositeNative,
  McpCompositeRecord,
  McpCompositeRepository,
  McpCompositeSettlement,
} from "../src/main/application/mcpCompositeWorkflowPorts";

export const owner = "composite-owner";
export const guard = () => {};
export const hash = (character = "a") => character.repeat(64);
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function compositePlan(review = false) {
  return McpCompositePrepareSchema.parse({
    requestId: randomUUID(),
    reason: "Explicit bounded test plan",
    targets: {
      kind: "saved",
      pages: [
        {
          workId: "work",
          chapterId: "chapter",
          pageId: "page",
          blockIds: ["block"],
        },
      ],
    },
    phases: review
      ? [
          { kind: "review", id: "review-one" },
          {
            kind: "native",
            id: "correction",
            action: "selection-apply",
            role: "correction",
          },
          { kind: "review", id: "review-two" },
        ]
      : [{ kind: "native", id: "work", action: "workflow-run" }],
    maxReviewPasses: review ? 2 : 1,
    budgets: {
      admissions: 10,
      pageAttempts: 10,
      selectedEdits: 10,
      models: {},
    },
  });
}
function memoryCompositeRepository(options: { failCheckpoint?: boolean } = {}) {
  const records = new Map<string, McpCompositeRecord>();
  const owned = (id: string, principal: string) => {
    const value = records.get(id);
    if (!value || value.owner !== principal)
      throw new McpEditError("not_found", "Unknown owned composite");
    return structuredClone(value);
  };
  const save = async (
    record: McpCompositeRecord,
    expected: number,
    check: () => void,
  ) => {
    check();
    if (owned(record.id, record.owner).version !== expected)
      throw new McpEditError("revision_conflict", "Concurrent record version");
    const parsed = parseCompositeRecord(record);
    records.set(record.id, structuredClone(parsed));
    return parsed;
  };
  const repository: McpCompositeRepository = {
    load: async (principal, id) => owned(id, principal),
    find: async (principal, requestId) =>
      structuredClone(
        [...records.values()].find(
          (record) =>
            record.owner === principal && record.plan.requestId === requestId,
        ) ?? null,
      ),
    create: async (record, check) => {
      check();
      const parsed = parseCompositeRecord(record);
      records.set(record.id, structuredClone(parsed));
      return parsed;
    },
    save,
    reserve: async (record, expected, check) => ({
      record: await save(record, expected, check),
      settlement: settlement(record),
    }),
  };
  function settlement(reserved: McpCompositeRecord): McpCompositeSettlement {
    const update = async (change: (record: McpCompositeRecord) => void) => {
      const record = owned(reserved.id, reserved.owner);
      const version = record.version;
      change(record);
      record.version += 1;
      return save(record, version, guard);
    };
    return {
      checkpointChild: async (receipt) => {
        if (options.failCheckpoint) throw new Error("Checkpoint write failed");
        return update((record) => {
          const phase = nextCompositePhase(record);
          if (phase) phase.child = receipt;
        });
      },
      finish: (outcome) =>
        update((record) => {
          const phase = nextCompositePhase(record);
          if (phase) {
            phase.child = outcome.receipt;
            phase.outcome = outcome;
            phase.status = "held";
          }
          if (record.status !== "cancelled") record.status = "held";
          record.stopReason = "native-outcome";
        }),
      hold: (reason) =>
        update((record) => {
          const phase = nextCompositePhase(record);
          if (phase) phase.status = "held";
          if (record.status !== "cancelled") record.status = "held";
          record.stopReason = reason;
          record.usageUnknown = true;
        }),
    };
  }
  return { repository, records };
}
export function compositeFixture(
  options: {
    waitForAbort?: boolean;
    failCheckpoint?: boolean;
    cleanup?: ReturnType<typeof deferred>;
  } = {},
) {
  const storage = memoryCompositeRepository(options);
  const entered = deferred();
  const events: string[] = [];
  let evidenceStale = false;
  const cost = zeroCompositeCost();
  cost.admissions = 1;
  cost.pageAttempts = 1;
  const snapshot = (pages: McpCompositeRecord["targets"]) => ({
    fingerprint: hash(),
    policyFingerprint: hash("b"),
    pages: pages.map((page) => ({
      ...page,
      revision: "page-v1:" + "a".repeat(16),
      reviewRevision: "page-v1:" + "b".repeat(16),
      sourceFingerprint: hash("c"),
      membershipFingerprint: hash("1"),
      memoryFingerprint: hash("2"),
      contextFingerprint: hash("d"),
      settingsFingerprint: hash("e"),
      fontFingerprint: hash("f"),
    })),
  });
  const receipt = (
    binding: McpCompositeBinding,
  ): McpCompositeChildReference => ({
    kind: "workflow",
    id: randomUUID(),
    requestId: binding.nativeRequestId,
    family: binding.family,
    inputFingerprint: binding.inputFingerprint,
  });
  const native: McpCompositeNative = {
    prepare: async (_principal, plan) =>
      snapshot(plan.targets.kind === "saved" ? plan.targets.pages : []),
    resolve: async (record, input) => ({
      owner,
      compositeId: record.id,
      phaseId: input.phaseId,
      action: input.action,
      family: input.action.kind,
      nativeRequestId: input.action.input.requestId,
      inputFingerprint: compositeFingerprint(input.action.input),
      nativeReference: {
        kind: "run",
        requestId: input.action.input.requestId,
        fingerprint: "a".repeat(16),
      },
      snapshot: record.snapshot,
      predecessorReceipts: input.predecessorReceipts,
      cost: structuredClone(cost),
    }),
    verify: async (_binding, check) => {
      check(["carrot.read"]);
    },
    execute: async (binding, signal, checkpoint, check) => {
      check();
      const persisted = storage.records.get(binding.compositeId);
      if (persisted?.status !== "running" || persisted.used.admissions < 1)
        throw new Error("Native start before durable reservation");
      events.push("admitted");
      entered.resolve();
      try {
        const reference = receipt(binding);
        await checkpoint(reference);
        if (options.waitForAbort && !signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        return {
          status: signal.aborted ? "cancelled" : "completed",
          receipt: reference,
          resultFingerprint: hash(),
        };
      } finally {
        await options.cleanup?.promise;
        events.push("physically-settled");
      }
    },
    control: async () => {},
    reconcile: async () => null,
    refresh: async (record) => snapshot(record.targets),
    renderEvidence: async (record, phaseId, pass) => {
      events.push("rendered");
      return record.snapshot.pages
        .map((page) => ({
          ...page,
          blockIds: undefined,
          membershipFingerprint: undefined,
          memoryFingerprint: undefined,
          id: randomUUID(),
          owner,
          compositeId: record.id,
          phaseId,
          pass,
          kind: "rendered-page" as const,
          fontEvidence: {
            appManaged: "bytes-sha256" as const,
            systemFallback: "native-render-pixels-only" as const,
          },
          sha256: hash(),
          width: 100,
          height: 200,
          pixelMapping: { originX: 0, originY: 0, scaleX: 1, scaleY: 1 },
          renderOptionsFingerprint: hash(),
          createdAt: Date.now(),
        }))
        .map(
          ({
            blockIds: _blockIds,
            membershipFingerprint: _membershipFingerprint,
            memoryFingerprint: _memoryFingerprint,
            ...evidence
          }) => evidence,
        );
    },
    verifyReviewReport: async () => {},
    verifyEvidence: async () => {
      if (evidenceStale)
        throw new McpEditError(
          "revision_conflict",
          "Saved rendering source changed",
        );
    },
  };
  const service = new McpCompositeWorkflowService(storage.repository, native);
  const bind = (record: McpCompositeRecord) => {
    const phase = nextCompositePhase(record);
    if (!phase) throw new Error("No remaining phase");
    const descriptor = record.plan.phases.find((item) => item.id === phase.id);
    const action =
      descriptor?.kind === "native" && descriptor.action === "selection-apply"
        ? {
            kind: "selection-apply" as const,
            input: { batchId: randomUUID(), requestId: randomUUID() },
          }
        : {
            kind: "workflow-run" as const,
            input: {
              id: randomUUID(),
              version: 0,
              requestId: randomUUID(),
              retryFailed: false,
            },
          };
    const input: McpCompositeBind = {
      id: record.id,
      version: record.version,
      requestId: randomUUID(),
      phaseId: phase.id,
      action,
      expectedSnapshot: record.snapshot.fingerprint,
      predecessorReceipts: compositePredecessors(record),
    };
    return service.bind(owner, input, guard);
  };
  return {
    ...storage,
    service,
    native,
    cost,
    events,
    entered,
    bind,
    staleEvidence: () => {
      evidenceStale = true;
    },
  };
}
export const mutation = (record: McpCompositeRecord) => ({
  id: record.id,
  version: record.version,
  requestId: randomUUID(),
});
export function reviewReport(
  record: McpCompositeRecord,
  verdict: "accepted" | "needs-correction" = "accepted",
) {
  const phase = nextCompositePhase(record);
  if (!phase?.evidence) throw new Error("No issued review evidence");
  return {
    ...mutation(record),
    phaseId: phase.id,
    pass: phase.evidence[0].pass,
    reviewerKind: "connected-ai" as const,
    verdictOrigin: "host-reported" as const,
    verdict,
    assessments: phase.evidence.map((item) => ({
      chapterId: item.chapterId,
      pageId: item.pageId,
      evidenceId: item.id,
    })),
    findings:
      verdict === "accepted"
        ? []
        : [
            {
              chapterId: "chapter",
              pageId: "page",
              blockId: "block",
              category: "overflow" as const,
              severity: "blocking" as const,
              message: "Text extends outside the reviewed balloon",
            },
          ],
    findingsOverflow: false,
  };
}
