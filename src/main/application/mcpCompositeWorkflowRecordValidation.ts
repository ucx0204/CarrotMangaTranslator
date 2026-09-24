import type { z } from "zod/v4";
import type {
  McpCompositeRecord,
  McpCompositeSavedBinding,
} from "./mcpCompositeWorkflowPorts";
import { compositeFingerprint } from "./mcpCompositeWorkflowPolicy";

export function validateCompositeRecord(
  record: McpCompositeRecord,
  context: z.RefinementCtx,
) {
  const fail = (message: string) =>
    context.addIssue({ code: "custom", message });
  if (record.expiresAt !== record.createdAt + 7 * 24 * 60 * 60_000)
    fail("Composite lifetime must remain seven days.");
  if (
    record.phases.length !== record.plan.phases.length ||
    record.phases.some((item, i) => item.id !== record.plan.phases[i]?.id)
  )
    fail("Fixed phases must retain their declared identity and order.");
  if (record.phases.filter((item) => item.status === "running").length > 1)
    fail("Only one child may be active.");
  if (
    new Set(record.actions.map((item) => item.requestId)).size !==
    record.actions.length
  )
    fail("Action request IDs must be unique.");
  validateCounters(record, fail);
  if (
    record.used.pageEdits.reduce((sum, page) => sum + page.edits, 0) !==
      record.used.selectedEdits ||
    new Set(
      record.used.pageEdits.map((page) => `${page.chapterId}/${page.pageId}`),
    ).size !== record.used.pageEdits.length
  )
    fail("Used selected edits must retain exact per-page accounting.");
}
function validateCounters(
  record: McpCompositeRecord,
  fail: (message: string) => void,
) {
  for (const key of [
    "admissions",
    "pageAttempts",
    "translationRequests",
    "researchAttempts",
    "selectedEdits",
  ] as const)
    if (record.used[key] > record.plan.budgets[key])
      fail("Used native counters exceed preparation limits.");
  for (const key of Object.keys(record.used.models) as Array<
    keyof typeof record.used.models
  >)
    if (record.used.models[key] > record.plan.budgets.models[key])
      fail("Used model counters exceed preparation limits.");
}
export function validateCompositeConsistency(
  record: McpCompositeRecord,
  context: z.RefinementCtx,
) {
  const fail = (message: string) =>
    context.addIssue({ code: "custom", message });
  if (record.initialFingerprint !== compositeFingerprint(record.plan))
    fail("Prepared plan fingerprint changed.");
  const keys = record.targets.map((page) => `${page.chapterId}/${page.pageId}`);
  if (
    new Set(keys).size !== keys.length ||
    new Set(record.targets.map((page) => page.chapterId)).size > 10
  )
    fail("Target pages must be distinct and bounded by ten chapters.");
  const targetShape = (pages: typeof record.targets) =>
    pages.map(({ workId, chapterId, pageId, blockIds }) => ({
      workId,
      chapterId,
      pageId,
      blockIds,
    }));
  if (
    compositeFingerprint(targetShape(record.targets)) !==
    compositeFingerprint(targetShape(record.snapshot.pages))
  )
    fail("Current snapshot must cover the exact ordered target envelope.");
  if (
    record.plan.targets.kind === "saved" &&
    compositeFingerprint(record.targets) !==
      compositeFingerprint(record.plan.targets.pages)
  )
    fail("Saved target envelope cannot change.");
  if (
    record.status === "completed" &&
    record.phases.some(
      (phase) => phase.status !== "completed" && phase.status !== "skipped",
    )
  )
    fail("Parent completion requires every declared phase.");
  record.phases.forEach((phase, index) =>
    validatePhase(record, phase, index, fail),
  );
  validatePhaseOrder(record, fail);
}
function validatePhase(
  record: McpCompositeRecord,
  phase: McpCompositeRecord["phases"][number],
  index: number,
  fail: (message: string) => void,
) {
  const descriptor = record.plan.phases[index];
  validateBindingIdentity(record, phase, index, fail);
  if (phase.status === "skipped") validateSkipped(record, index, fail);
  if (descriptor?.kind === "native") validateNativeEvidence(phase, fail);
  if (
    phase.outcome &&
    (!phase.child ||
      compositeFingerprint(phase.outcome.receipt) !==
        compositeFingerprint(phase.child))
  )
    fail("Settled outcome requires its exact checkpointed child reference.");
  if (
    descriptor?.kind === "review" &&
    phase.status === "completed" &&
    (!phase.report || !phase.evidence)
  )
    fail(
      "Review phase completion requires issued render evidence and a host report.",
    );
}
function validateBindingIdentity(
  record: McpCompositeRecord,
  phase: McpCompositeRecord["phases"][number],
  index: number,
  fail: (message: string) => void,
) {
  const binding = phase.binding;
  if (!binding) return;
  const descriptor = record.plan.phases[index];
  if (
    binding.owner !== record.owner ||
    binding.compositeId !== record.id ||
    binding.phaseId !== phase.id ||
    descriptor?.kind !== "native" ||
    binding.family !== descriptor.action
  )
    fail("Native binding changed parent, owner or declared phase.");
  if (
    binding.nativeReference &&
    binding.nativeReference.requestId !== binding.nativeRequestId
  )
    fail("Native journal reference changed the admitted request ID.");
}
function validateNativeEvidence(
  phase: McpCompositeRecord["phases"][number],
  fail: (message: string) => void,
) {
  const binding = phase.binding;
  if (
    (phase.child || phase.outcome || phase.status === "running") &&
    (!binding || !phase.attemptId)
  )
    fail("Native evidence requires a durably reserved exact attempt.");
  if (phase.status === "completed" && phase.outcome?.status !== "completed")
    fail("Native phase completion requires successful settled evidence.");
  if (phase.child && binding) validateChildIdentity(phase.child, binding, fail);
}
function validateChildIdentity(
  child: NonNullable<McpCompositeRecord["phases"][number]["child"]>,
  binding: McpCompositeSavedBinding,
  fail: (message: string) => void,
) {
  if (
    child.family !== binding.family ||
    child.requestId !== binding.nativeRequestId ||
    child.inputFingerprint !== binding.inputFingerprint
  )
    fail("Child receipt differs from the exact bound native action.");
}

function validateSkipped(
  record: McpCompositeRecord,
  index: number,
  fail: (message: string) => void,
) {
  const descriptor = record.plan.phases[index];
  const phase = record.phases[index];
  if (descriptor?.kind === "native" && descriptor.role !== "correction")
    fail("Ordinary native work cannot be skipped by host review.");
  if (hasPhaseEvidence(phase))
    fail("Review cannot skip an already bound or admitted phase.");
  const prior = record.phases
    .slice(0, index)
    .reverse()
    .find((item) => item.status !== "skipped");
  if (prior?.report?.verdict !== "accepted")
    fail("Skipped corrections require a prior accepted host report.");
}
function hasPhaseEvidence(phase: McpCompositeRecord["phases"][number]) {
  return Boolean(
    phase.attemptId ||
    phase.binding ||
    phase.child ||
    phase.outcome ||
    phase.evidence ||
    phase.report,
  );
}
function validatePhaseOrder(
  record: McpCompositeRecord,
  fail: (message: string) => void,
) {
  let pending = false;
  for (const phase of record.phases) {
    if (pending && phase.status !== "unbound")
      fail("Later phases cannot advance before the next pending phase.");
    if (phase.status !== "completed" && phase.status !== "skipped")
      pending = true;
  }
  if (record.status !== "completed") return;
  const review = record.phases
    .slice()
    .reverse()
    .find((phase) => phase.report)?.report;
  if (record.stopReason || (review && review.verdict !== "accepted"))
    fail(
      "A completed parent cannot conceal unresolved review or a stop reason.",
    );
}
