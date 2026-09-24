import { createHash } from "node:crypto";
import { McpEditError } from "./mcpEditPolicy";
import {
  MCP_COMPOSITE_RECEIPTS,
  McpCompositePagesSchema,
} from "../../shared/mcpCompositeWorkflow";
import type {
  McpCompositeBind,
  McpCompositeChildReference,
  McpCompositePage,
} from "../../shared/mcpCompositeWorkflow";
import type {
  McpCompositeBinding,
  McpCompositeCost,
  McpCompositeOutcome,
  McpCompositeRecord,
  McpCompositeSavedBinding,
  McpCompositeSnapshot,
} from "./mcpCompositeWorkflowPorts";

export function compositeFingerprint(value: unknown): string {
  const encoded = JSON.stringify(canonical(value));
  if (encoded === undefined)
    compositeError("Undefined values have no composite fingerprint.");
  return createHash("sha256").update(encoded).digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
export function compositeError(message: string): never {
  throw new McpEditError("invalid_edit", message);
}
export function zeroCompositeCost(): McpCompositeCost {
  return {
    admissions: 0,
    pageAttempts: 0,
    translationRequests: 0,
    researchAttempts: 0,
    selectedEdits: 0,
    pageEdits: [],
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
export function reserveCompositeCost(
  record: McpCompositeRecord,
  cost: McpCompositeCost,
) {
  const next = structuredClone(record.used);
  for (const key of [
    "admissions",
    "pageAttempts",
    "translationRequests",
    "researchAttempts",
    "selectedEdits",
  ] as const)
    next[key] = boundedSum(next[key], cost[key], record.plan.budgets[key]);
  for (const key of Object.keys(next.models) as Array<keyof typeof next.models>)
    next.models[key] = boundedSum(
      next.models[key],
      cost.models[key],
      record.plan.budgets.models[key],
    );
  if (cost.admissions !== 1)
    compositeError(
      "Each parent attempt must reserve exactly one native admission.",
    );
  next.pageEdits = reservePageEdits(record, cost);
  record.used = next;
}
function boundedSum(used: number, cost: number, limit: number) {
  if (!Number.isSafeInteger(cost) || cost < 0 || used + cost > limit)
    compositeError(
      "The server-resolved native cost exceeds the authorized remaining budget.",
    );
  return used + cost;
}
export function rememberCompositeAction(
  record: McpCompositeRecord,
  requestId: string,
  input: unknown,
) {
  const fingerprint = compositeFingerprint(input);
  const existing = record.actions.find(
    (action) => action.requestId === requestId,
  );
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      compositeError("Request ID was already used with different input.");
    return false;
  }
  if (record.actions.length >= MCP_COMPOSITE_RECEIPTS)
    compositeError("The bounded parent action journal is full.");
  record.actions.push({ requestId, fingerprint });
  return true;
}
export function compositePredecessors(
  record: McpCompositeRecord,
): McpCompositeChildReference[] {
  return record.phases.flatMap((phase) =>
    phase.status === "completed" && phase.outcome
      ? [phase.outcome.receipt]
      : [],
  );
}
export function assertCompositeBinding(
  record: McpCompositeRecord,
  input: McpCompositeBind,
  binding: McpCompositeBinding,
) {
  const phase = nextCompositePhase(record);
  if (!phase || phase.id !== input.phaseId)
    compositeError("Only the next declared phase can be bound.");
  const descriptor = record.plan.phases.find((item) => item.id === phase.id);
  if (descriptor?.kind !== "native" || descriptor.action !== input.action.kind)
    compositeError("The phase native family is fixed by preparation.");
  assertBindingAction(record, input, binding);
  const predecessors = compositeFingerprint(compositePredecessors(record));
  if (
    compositeFingerprint(input.predecessorReceipts) !== predecessors ||
    compositeFingerprint(binding.predecessorReceipts) !== predecessors
  )
    compositeError("Bind the exact completed predecessor receipts.");
  if (
    input.expectedSnapshot !== record.snapshot.fingerprint ||
    binding.snapshot.fingerprint !== input.expectedSnapshot
  )
    compositeError("Bind explicitly refreshed native snapshots.");
  assertCompositeSnapshot(record, binding.snapshot);
}
export function savedCompositeBinding(
  binding: McpCompositeBinding,
): McpCompositeSavedBinding {
  const { action: _action, ...saved } = binding;
  return structuredClone(saved);
}
export function nextCompositePhase(record: McpCompositeRecord) {
  return record.phases.find(
    (phase) => phase.status !== "completed" && phase.status !== "skipped",
  );
}
export function assertCompositeSnapshot(
  record: McpCompositeRecord,
  snapshot: McpCompositeSnapshot,
) {
  if (snapshot.policyFingerprint !== record.snapshot.policyFingerprint)
    compositeError(
      "Settings, provider or paid-processing authorization cannot expand during refresh.",
    );
  assertCompositePages(record.targets, snapshot.pages);
}
export function assertCompositePages(
  targets: McpCompositePage[],
  pages: McpCompositePage[],
) {
  const allowed = new Map(
    targets.map((page) => [`${page.chapterId}/${page.pageId}`, page]),
  );
  if (pages.length !== targets.length)
    compositeError("The explicit page selection cannot change.");
  for (const page of pages) {
    const target = allowed.get(`${page.chapterId}/${page.pageId}`);
    if (
      !target ||
      target.workId !== page.workId ||
      compositeFingerprint(target.blockIds) !==
        compositeFingerprint(page.blockIds)
    )
      compositeError("The explicit page and block selection cannot change.");
    allowed.delete(`${page.chapterId}/${page.pageId}`);
  }
}
export function assertCompositeOutcome(
  binding: McpCompositeSavedBinding,
  outcome: McpCompositeOutcome,
) {
  const receipt = outcome.receipt;
  if (
    receipt.family !== binding.family ||
    receipt.requestId !== binding.nativeRequestId ||
    receipt.inputFingerprint !== binding.inputFingerprint
  )
    compositeError(
      "Native settlement must match the exact admitted action receipt.",
    );
}
export function applyCompositeImport(
  record: McpCompositeRecord,
  outcome: McpCompositeOutcome,
) {
  const envelope = record.plan.targets;
  if (envelope.kind !== "reviewed-import" || record.targets.length) return;
  const mapping = outcome.imported;
  if (
    !mapping ||
    mapping.selectionFingerprint !== envelope.selectionFingerprint ||
    compositeFingerprint(mapping.items.map((item) => item.itemKey)) !==
      compositeFingerprint(envelope.itemKeys)
  )
    compositeError(
      "The native receipt does not map the exact reviewed imported items.",
    );
  const pages = McpCompositePagesSchema.parse(
    mapping.items.map((item) => item.page),
  );
  if (
    pages.length > envelope.maxPages ||
    new Set(pages.map((page) => page.chapterId)).size > envelope.maxChapters
  )
    compositeError("Imported mapping exceeds the fixed target envelope.");
  record.targets = pages;
}

function reservePageEdits(record: McpCompositeRecord, cost: McpCompositeCost) {
  if (
    new Set(cost.pageEdits.map((page) => `${page.chapterId}/${page.pageId}`))
      .size !== cost.pageEdits.length ||
    cost.pageEdits.reduce((sum, page) => sum + page.edits, 0) !==
      cost.selectedEdits
  )
    compositeError(
      "Selected-edit cost requires an exact qualified-page allocation.",
    );
  const totals = new Map(
    record.used.pageEdits.map((page) => [
      `${page.chapterId}/${page.pageId}`,
      { ...page },
    ]),
  );
  for (const page of cost.pageEdits) {
    if (
      !record.targets.some(
        (target) =>
          target.chapterId === page.chapterId && target.pageId === page.pageId,
      )
    )
      compositeError(
        "Selected-edit costs cannot expand the prepared page scope.",
      );
    const key = `${page.chapterId}/${page.pageId}`;
    const total = boundedSum(totals.get(key)?.edits ?? 0, page.edits, 100);
    totals.set(key, {
      chapterId: page.chapterId,
      pageId: page.pageId,
      edits: total,
    });
  }
  return [...totals.values()];
}

function assertBindingAction(
  record: McpCompositeRecord,
  input: McpCompositeBind,
  binding: McpCompositeBinding,
) {
  if (
    binding.owner !== record.owner ||
    binding.compositeId !== record.id ||
    binding.phaseId !== input.phaseId
  )
    compositeError("The native binding belongs to another parent or phase.");
  if (
    binding.family !== input.action.kind ||
    binding.inputFingerprint !== compositeFingerprint(input.action.input) ||
    binding.nativeRequestId !== input.action.input.requestId ||
    compositeFingerprint(binding.action) !== compositeFingerprint(input.action)
  )
    compositeError("The exact native action must be bound before admission.");
}
