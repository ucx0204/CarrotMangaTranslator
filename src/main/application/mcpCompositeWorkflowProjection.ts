import { hashStableValue } from "../../shared/blockFingerprint";
import {
  McpCompositeViewSchema,
  mcpCompositeWorkflowOutputs,
} from "../../shared/mcpCompositeWorkflowOutputs";
import type {
  McpCompositeRecord,
  McpCompositePhaseState,
} from "./mcpCompositeWorkflowPorts";
import { parseCompositeRecord } from "./mcpCompositeWorkflowRecord";
import { McpEditError } from "./mcpEditPolicy";

type Window = { offset: number; limit: number; snapshot?: string };

/** Only declared plan/evidence metadata crosses transport; native inputs and internal references stay private. */
export function compositeWorkflowView(value: McpCompositeRecord) {
  const record = parseCompositeRecord(value);
  const { pageEdits: _pageEdits, ...used } = record.used;
  return McpCompositeViewSchema.parse({
    ...summary(record),
    plan: record.plan,
    snapshot: record.snapshot.fingerprint,
    targets: record.targets,
    used,
    phases: record.phases.map((phase, index) => ({
      descriptor: record.plan.phases[index],
      status: phase.status,
      ...(phase.binding
        ? {
            binding: {
              family: phase.binding.family,
              nativeRequestId: phase.binding.nativeRequestId,
              inputFingerprint: phase.binding.inputFingerprint,
              snapshot: phase.binding.snapshot.fingerprint,
            },
          }
        : {}),
      ...(phase.attemptId ? { attemptId: phase.attemptId } : {}),
      ...(phase.child ? { child: phase.child } : {}),
      ...(phase.outcome ? { outcome: phase.outcome } : {}),
      evidenceCount: phase.evidence?.length ?? 0,
      ...(phase.report ? { report: reportSummary(phase.report) } : {}),
    })),
  });
}

export function compositeWorkflowList(
  records: McpCompositeRecord[],
  input: Window,
) {
  const checked = records.map(parseCompositeRecord);
  const snapshot = hashStableValue(
    checked.map((record) => [record.id, record.version, record.status]),
  );
  const page = paginate(checked, input, snapshot);
  return mcpCompositeWorkflowOutputs.carrot_list_composites.parse({
    ...page,
    items: page.items.map(summary),
  });
}

export function compositeWorkflowReview(
  value: McpCompositeRecord,
  phaseId: string,
  input: Window,
) {
  const record = parseCompositeRecord(value);
  const phase = compositeReviewPhase(record, phaseId);
  const snapshot = hashStableValue([record.id, record.version, phase]);
  return mcpCompositeWorkflowOutputs.carrot_get_composite_review.parse({
    id: record.id,
    version: record.version,
    phaseId,
    status: phase.status,
    evidence: (phase.evidence ?? []).map(({ owner: _owner, ...item }) => item),
    ...(phase.report ? { report: reportSummary(phase.report) } : {}),
    findings: paginate(phase.report?.findings ?? [], input, snapshot),
    observation:
      "metadata-only; retrieve-issued-render-image-before-host-assessment",
  });
}

export function compositeReviewPhase(
  record: McpCompositeRecord,
  phaseId: string,
) {
  const index = record.plan.phases.findIndex(
    (phase) => phase.id === phaseId && phase.kind === "review",
  );
  const phase = record.phases[index];
  if (!phase)
    throw new McpEditError(
      "not_found",
      "The owned composite has no such review phase.",
    );
  return phase;
}

function summary(record: McpCompositeRecord) {
  return {
    kind: record.kind,
    format: record.format,
    id: record.id,
    version: record.version,
    status: record.status,
    ...(record.stopReason ? { stopReason: record.stopReason } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    pageCount: record.targets.length,
    phaseCount: record.phases.length,
    completedPhases: record.phases.filter(
      (phase) => phase.status === "completed" || phase.status === "skipped",
    ).length,
    usageUnknown: record.usageUnknown,
    retention:
      "seven-days; same-profile-and-owner; no-automatic-reexecution" as const,
    automaticResume: false as const,
    crossOwnerHandoff: false as const,
  };
}

function reportSummary(report: NonNullable<McpCompositePhaseState["report"]>) {
  return {
    reviewerKind: report.reviewerKind,
    verdictOrigin: report.verdictOrigin,
    verdict: report.verdict,
    findingsCount: report.findings.length,
    findingsOverflow: report.findingsOverflow,
  };
}

function paginate<T>(items: T[], input: Window, snapshot: string) {
  if (
    (input.offset > 0 && !input.snapshot) ||
    (input.snapshot && input.snapshot !== snapshot)
  )
    throw new McpEditError(
      "revision_conflict",
      "Composite metadata changed. Restart pagination from offset zero.",
    );
  return {
    total: items.length,
    offset: input.offset,
    limit: input.limit,
    snapshot,
    nextOffset:
      input.offset + input.limit < items.length
        ? input.offset + input.limit
        : null,
    items: items.slice(input.offset, input.offset + input.limit),
  };
}
