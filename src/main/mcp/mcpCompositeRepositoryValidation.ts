import {
  applyCompositeImport,
  compositeFingerprint,
  nextCompositePhase,
  reserveCompositeCost,
  zeroCompositeCost,
} from "../application/mcpCompositeWorkflowPolicy";
import type { McpCompositeRecord } from "../application/mcpCompositeWorkflowPorts";
import { McpEditError } from "../application/mcpEditPolicy";

function invalid(message: string): never {
  throw new McpEditError("invalid_edit", message);
}
export function sameCompositeValue(left: unknown, right: unknown) {
  if (left === undefined || right === undefined) return left === right;
  return compositeFingerprint(left) === compositeFingerprint(right);
}
export function assertCompositeInitialRecord(record: McpCompositeRecord) {
  if (
    record.version !== 0 ||
    record.status !== "prepared" ||
    record.actions.length ||
    record.usageUnknown ||
    record.reviewPairs.length ||
    record.stopReason ||
    !sameCompositeValue(record.used, zeroCompositeCost())
  )
    invalid(
      "Composite preparation cannot admit work or consume action history.",
    );
  if (
    record.phases.some(
      (phase) =>
        phase.status !== "unbound" ||
        Object.keys(phase).some((key) => !["id", "status"].includes(key)),
    )
  )
    invalid("Composite preparation must leave every phase unbound.");
}
export function assertCompositeIdentity(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
) {
  const identity = (record: McpCompositeRecord) => ({
    id: record.id,
    owner: record.owner,
    format: record.format,
    kind: record.kind,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    plan: record.plan,
    initialFingerprint: record.initialFingerprint,
    policyFingerprint: record.snapshot.policyFingerprint,
  });
  if (!sameCompositeValue(identity(current), identity(next)))
    invalid("Composite identity, approved plan and lifetime are immutable.");
}
export function assertCompositeTransition(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
  expectedVersion: number,
) {
  if (current.version !== expectedVersion)
    throw new McpEditError(
      "revision_conflict",
      "Composite version changed. Inspect the existing receipt.",
    );
  if (next.version !== expectedVersion + 1)
    invalid("Composite checkpoints must advance exactly one version.");
  assertCompositeIdentity(current, next);
  if (
    ["cancelled", "completed"].includes(current.status) &&
    next.status !== current.status
  )
    invalid("A terminal composite parent cannot be reopened.");
  assertActionPrefix(current, next);
  assertPhaseHistory(current, next);
  assertTargetTransition(current, next);
  assertMonotonicCounters(current, next);
}
function assertActionPrefix(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
) {
  if (
    next.actions.length < current.actions.length ||
    next.actions.length > current.actions.length + 1 ||
    !sameCompositeValue(
      next.actions.slice(0, current.actions.length),
      current.actions,
    )
  )
    invalid(
      "Composite action receipts cannot be removed, replaced or appended in bulk.",
    );
  if (next.actions.some((action) => action.requestId === next.plan.requestId))
    invalid("A control action cannot reuse its preparation request ID.");
}
function assertPhaseHistory(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
) {
  for (const [index, before] of current.phases.entries()) {
    const after = next.phases[index];
    if (!after) invalid("A declared phase cannot disappear.");
    if (
      ["completed", "skipped"].includes(before.status) &&
      !sameCompositeValue(before, after)
    )
      invalid("Completed phase evidence cannot be replaced.");
    assertAdmittedHistory(before, after);
  }
}
function assertAdmittedHistory(
  before: McpCompositeRecord["phases"][number],
  after: McpCompositeRecord["phases"][number],
) {
  if (
    before.attemptId &&
    (before.attemptId !== after.attemptId ||
      !sameCompositeValue(before.binding, after.binding))
  )
    invalid("An admitted phase cannot be rebound or retried.");
  if (before.attemptId && after.status === "skipped")
    invalid("An admitted native attempt cannot be relabeled as skipped.");
  for (const key of ["child", "outcome", "evidence", "report"] as const)
    if (before[key] && !sameCompositeValue(before[key], after[key]))
      invalid(
        "Known native outcomes, child references or issued review evidence cannot be replaced or forgotten.",
      );
}
function assertTargetTransition(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
) {
  if (sameCompositeValue(current.targets, next.targets)) return;
  const envelope = current.plan.targets;
  if (current.targets.length || envelope.kind !== "reviewed-import")
    invalid("Composite saved targets cannot expand or change.");
  const phase = next.phases.find((item) => item.id === envelope.phaseId);
  if (!phase?.outcome || phase.outcome.status !== "completed")
    invalid(
      "Imported target mapping requires an exact completed native receipt.",
    );
  const mapped = structuredClone(current);
  applyCompositeImport(mapped, phase.outcome);
  if (!sameCompositeValue(mapped.targets, next.targets))
    invalid("Imported targets differ from the native reviewed-item mapping.");
}
function assertMonotonicCounters(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
) {
  for (const key of [
    "admissions",
    "pageAttempts",
    "translationRequests",
    "researchAttempts",
    "selectedEdits",
  ] as const)
    if (next.used[key] < current.used[key])
      invalid("Durable budget reservations cannot be refunded.");
  for (const key of Object.keys(current.used.models) as Array<
    keyof typeof current.used.models
  >)
    if (next.used.models[key] < current.used.models[key])
      invalid("Model reservations cannot be refunded.");
  const pageEdits = new Map(
    next.used.pageEdits.map((page) => [
      `${page.chapterId}/${page.pageId}`,
      page.edits,
    ]),
  );
  for (const page of current.used.pageEdits)
    if ((pageEdits.get(`${page.chapterId}/${page.pageId}`) ?? 0) < page.edits)
      invalid(
        "Per-page edit reservations cannot be refunded or moved to another page.",
      );
  if (current.usageUnknown && !next.usageUnknown)
    invalid("Unknown native usage cannot be rewritten as known zero usage.");
}
export function assertCompositeOrdinarySave(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
  active: boolean,
) {
  if (active && !sameCompositeValue(current.phases, next.phases))
    invalid(
      "A live child's phase can be settled only by its issued capability.",
    );
  assertOrdinaryNativeIdentities(current, next);
  const opened = next.phases.filter(
    (phase, index) =>
      phase.status === "running" && current.phases[index]?.status !== "running",
  );
  if (
    opened.some(
      (phase) =>
        next.plan.phases.find((item) => item.id === phase.id)?.kind !==
        "review",
    )
  )
    invalid("Native execution requires a durable reservation capability.");
  if (opened.length || !sameCompositeValue(current.used, next.used))
    assertReviewReservation(current, next, opened);
}
function assertOrdinaryNativeIdentities(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
) {
  for (const [index, phase] of next.phases.entries()) {
    if (next.plan.phases[index]?.kind !== "native") continue;
    const before = current.phases[index];
    if (phase.attemptId !== before?.attemptId)
      invalid("Only durable reservation can create a native attempt identity.");
    if ((phase.child || phase.outcome) && !before?.attemptId)
      invalid("A child receipt requires an already reserved native attempt.");
  }
}
function assertReviewReservation(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
  opened: McpCompositeRecord["phases"],
) {
  const phase = nextCompositePhase(current);
  if (
    opened.length !== 1 ||
    opened[0].id !== phase?.id ||
    next.status !== "running"
  )
    invalid("Only the next review phase can reserve its render work.");
  const expected = structuredClone(current);
  reserveCompositeCost(expected, {
    ...zeroCompositeCost(),
    admissions: 1,
    pageAttempts: current.targets.length,
  });
  if (!sameCompositeValue(expected.used, next.used))
    invalid("Review rendering must reserve the exact declared page count.");
}
export function assertCompositeNativeReservation(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
) {
  if (current.status === "cancelled")
    invalid("A cancelled parent cannot admit new native work.");
  const { phase, index, binding, attemptId } = nativeReservationTarget(
    current,
    next,
  );
  if (
    current.actions.length >= 128 ||
    next.actions.length !== current.actions.length + 1
  )
    invalid(
      "A native admission requires one new receipt in its durable action history.",
    );
  const expected = structuredClone(current);
  reserveCompositeCost(expected, binding.cost);
  expected.version = next.version;
  expected.updatedAt = next.updatedAt;
  expected.status = "running";
  expected.actions = next.actions;
  expected.phases[index] = { ...phase, status: "running", attemptId };
  delete expected.stopReason;
  if (!sameCompositeValue(expected, next))
    invalid(
      "Reservation must persist exactly its approved attempt and aggregate cost before admission.",
    );
  return index;
}
function nativeReservationTarget(
  current: McpCompositeRecord,
  next: McpCompositeRecord,
) {
  const phase = nextCompositePhase(current);
  const index = current.phases.findIndex((item) => item.id === phase?.id);
  const started = next.phases[index];
  if (
    !phase?.binding ||
    phase.status !== "bound" ||
    phase.attemptId ||
    !started?.attemptId ||
    current.plan.phases[index]?.kind !== "native"
  )
    invalid("Reserve only the next explicitly bound native phase, once.");
  return { phase, index, binding: phase.binding, attemptId: started.attemptId };
}
