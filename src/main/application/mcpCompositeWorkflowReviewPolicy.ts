import { McpCompositeRenderEvidenceSchema } from "../../shared/mcpCompositeWorkflowReview";
import type {
  McpCompositeRenderEvidence,
  McpCompositeReviewReport,
} from "../../shared/mcpCompositeWorkflowReview";
import type { McpCompositeRecord } from "./mcpCompositeWorkflowPorts";
import {
  compositeError,
  compositeFingerprint,
  nextCompositePhase,
} from "./mcpCompositeWorkflowPolicy";

export function assertCompositeEvidence(
  record: McpCompositeRecord,
  phaseId: string,
  pass: number,
  issued: McpCompositeRenderEvidence[],
) {
  const evidence = McpCompositeRenderEvidenceSchema.array()
    .min(1)
    .max(50)
    .parse(issued);
  const remaining = new Map(
    record.snapshot.pages.map((page) => [
      `${page.chapterId}/${page.pageId}`,
      page,
    ]),
  );
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length)
    compositeError("Render evidence IDs must be distinct.");
  for (const item of evidence) {
    const key = `${item.chapterId}/${item.pageId}`;
    const page = remaining.get(key);
    if (
      !page ||
      item.owner !== record.owner ||
      item.compositeId !== record.id ||
      item.phaseId !== phaseId ||
      item.pass !== pass
    )
      compositeError(
        "Render evidence is not issued for this exact parent review selection.",
      );
    for (const field of [
      "workId",
      "revision",
      "reviewRevision",
      "sourceFingerprint",
      "contextFingerprint",
      "settingsFingerprint",
      "fontFingerprint",
    ] as const)
      if (item[field] !== page[field])
        compositeError(
          "Rendered output evidence does not match the refreshed source snapshot.",
        );
    remaining.delete(key);
  }
  if (remaining.size)
    compositeError("Every selected page requires actual rendered evidence.");
  return evidence;
}
export function acceptCompositeReport(
  record: McpCompositeRecord,
  report: McpCompositeReviewReport,
) {
  const phase = nextCompositePhase(record);
  if (
    !phase ||
    phase.id !== report.phaseId ||
    phase.status !== "awaiting-review" ||
    !phase.evidence
  )
    compositeError("The next phase is not awaiting this host review.");
  assertReportEvidence(record, phase.evidence, report);
  const pair = reviewPair(phase.evidence, report);
  const prior = record.reviewPairs.indexOf(pair);
  phase.report = structuredClone(report);
  phase.status = "completed";
  if (report.verdict === "accepted")
    return skipAcceptedReviewTail(record, phase.id);
  return continueReview(record, report, pair, prior);
}
function continueReview(
  record: McpCompositeRecord,
  report: McpCompositeReviewReport,
  pair: string,
  prior: number,
) {
  if (report.verdict === "blocked" || report.findingsOverflow)
    return holdReview(record, "review-blocked");
  if (prior >= 0)
    return holdReview(
      record,
      prior === record.reviewPairs.length - 1 ? "no-progress" : "oscillation",
    );
  record.reviewPairs.push(pair);
  const next = nextCompositePhase(record);
  const descriptor = record.plan.phases.find((item) => item.id === next?.id);
  if (
    report.pass >= record.plan.maxReviewPasses ||
    descriptor?.kind !== "native" ||
    descriptor.role !== "correction"
  )
    holdReview(record, "review-blocked");
}
function assertReportEvidence(
  record: McpCompositeRecord,
  evidence: McpCompositeRenderEvidence[],
  report: McpCompositeReviewReport,
) {
  const issued = new Map(
    evidence.map((item) => [`${item.chapterId}/${item.pageId}`, item]),
  );
  if (report.assessments.length !== issued.size)
    compositeError("Host review must assess every selected rendered page.");
  for (const item of report.assessments) {
    const key = `${item.chapterId}/${item.pageId}`;
    const current = issued.get(key);
    if (
      !current ||
      item.evidenceId !== current.id ||
      report.pass !== current.pass
    )
      compositeError(
        "Host review references unissued or stale render evidence.",
      );
    issued.delete(key);
  }
  assertFindingEnvelope(record, report);
}
function assertFindingEnvelope(
  record: McpCompositeRecord,
  report: McpCompositeReviewReport,
) {
  for (const finding of report.findings) {
    const page = record.targets.find(
      (item) =>
        item.chapterId === finding.chapterId && item.pageId === finding.pageId,
    );
    if (
      !page ||
      (finding.blockId &&
        page.blockIds.length > 0 &&
        !page.blockIds.includes(finding.blockId))
    )
      compositeError("Host findings cannot expand the page or block envelope.");
  }
  if (
    report.verdict === "accepted" &&
    (report.findingsOverflow ||
      report.findings.some((item) => item.severity === "blocking"))
  )
    compositeError(
      "An accepted host report cannot conceal unresolved blocking findings.",
    );
}
function reviewPair(
  evidence: McpCompositeRenderEvidence[],
  report: McpCompositeReviewReport,
) {
  const renders = evidence
    .map(
      ({
        id: _id,
        owner: _owner,
        compositeId: _parent,
        phaseId: _phase,
        pass: _pass,
        createdAt: _time,
        ...stable
      }) => stable,
    )
    .sort((a, b) =>
      `${a.chapterId}/${a.pageId}`.localeCompare(`${b.chapterId}/${b.pageId}`),
    );
  const findings = report.findings
    .map((item) => ({
      ...item,
      message: item.message.trim().replace(/\s+/g, " "),
    }))
    .sort((a, b) =>
      compositeFingerprint(a).localeCompare(compositeFingerprint(b)),
    );
  return compositeFingerprint({ renders, findings });
}
function holdReview(
  record: McpCompositeRecord,
  reason: "no-progress" | "oscillation" | "review-blocked",
) {
  record.status = "held";
  record.stopReason = reason;
}
export function assertCompositeCorrection(
  record: McpCompositeRecord,
  phaseId: string,
) {
  const index = record.plan.phases.findIndex((phase) => phase.id === phaseId);
  const descriptor = record.plan.phases[index];
  if (descriptor?.kind !== "native" || descriptor.role !== "correction") return;
  const prior = record.phases
    .slice(0, index)
    .reverse()
    .find((phase) => phase.report);
  if (
    prior?.report?.verdict !== "needs-correction" ||
    !record.plan.phases
      .slice(index + 1)
      .some((phase) => phase.kind === "review")
  )
    compositeError(
      "Corrections require explicit unresolved host findings and a later rendered review pass.",
    );
}

function skipAcceptedReviewTail(record: McpCompositeRecord, phaseId: string) {
  const start = record.phases.findIndex((phase) => phase.id === phaseId) + 1;
  for (let index = start; index < record.plan.phases.length; index += 1) {
    const descriptor = record.plan.phases[index];
    if (descriptor.kind === "native" && descriptor.role !== "correction") break;
    const phase = record.phases[index];
    if (phase.status !== "unbound")
      compositeError(
        "A successful review cannot skip an already admitted phase.",
      );
    phase.status = "skipped";
  }
}
