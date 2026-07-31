import type { FontMatchingDecisionPrioritySource } from "../../shared/fontMatchingProfileTypes";
import { FONT_MATCHING_DECISION_PRIORITY } from "../../shared/fontMatchingProfileTypes";
import {
  addDecisionRejection,
  evaluateCandidate,
  rankedEligibleCandidates,
  type CandidateEvaluation,
  type DecisionState,
} from "./fontMatchingDecisionV2Candidates";
import type {
  FontCandidateRejectionAuditV2,
  FontDecisionPriorityTraceV2,
} from "./fontMatchingDecisionV2Types";

export function recordDecisionTrace(
  state: DecisionState,
  priority: FontMatchingDecisionPrioritySource,
  status: FontDecisionPriorityTraceV2["status"],
  candidateFontId: string | null,
  reasonCodes: readonly string[],
): void {
  state.trace.set(priority, {
    priority,
    status,
    candidateFontId,
    reasonCodes: uniqueSorted(reasonCodes),
  });
}

export function buildDecisionAudit(
  state: DecisionState,
  resolvedBy: FontMatchingDecisionPrioritySource,
) {
  fillDecisionTrace(state, resolvedBy);
  const evaluatedCandidates = [...state.evaluations.values()].sort(
    compareCandidatesForAudit,
  );
  return {
    policyVersion: "font-matching-decision-v2.0" as const,
    legacyTitleOrRegexFallbackUsed: false as const,
    modelReportedNoneAcceptable: state.input.localEvidence.noneAcceptable,
    localCalibratedConfidence: state.input.localEvidence.calibratedConfidence,
    roleConfidence: state.input.role.confidence,
    genreContributionCap: state.genreCap,
    evaluatedCandidates,
    rejectedCandidates: buildRejectionAudit(state, evaluatedCandidates),
    priorityTrace: FONT_MATCHING_DECISION_PRIORITY.map(
      (priority) => state.trace.get(priority) as FontDecisionPriorityTraceV2,
    ),
  };
}

export function buildTopCandidateIds(
  state: DecisionState,
  selectedFontId: string | null,
): string[] {
  const ids = selectedFontId ? [selectedFontId] : [];
  addUserDefaultSuggestion(state, ids, selectedFontId);
  for (const candidate of rankedEligibleCandidates(state))
    ids.push(candidate.fontId);
  return [...new Set(ids)].slice(0, 3);
}

function addUserDefaultSuggestion(
  state: DecisionState,
  ids: string[],
  selectedFontId: string | null,
): void {
  const userDefault = state.input.userDefaultCandidate?.fontId;
  if (!userDefault || selectedFontId) return;
  const evaluation = evaluateCandidate(state, userDefault);
  if (evaluation.hardRejectReasons.length === 0) {
    ids.push(userDefault);
    return;
  }
  addDecisionRejection(state, userDefault, "policy", [
    "user_default_unavailable",
  ]);
}

function fillDecisionTrace(
  state: DecisionState,
  resolvedBy: FontMatchingDecisionPrioritySource,
): void {
  const resolvedIndex = FONT_MATCHING_DECISION_PRIORITY.indexOf(resolvedBy);
  for (const [index, priority] of FONT_MATCHING_DECISION_PRIORITY.entries()) {
    if (state.trace.has(priority)) continue;
    const afterResolution = index > resolvedIndex;
    recordDecisionTrace(
      state,
      priority,
      afterResolution ? "not_reached" : "skipped",
      null,
      [afterResolution ? "higher_priority_selected" : "no_selection"],
    );
  }
}

function buildRejectionAudit(
  state: DecisionState,
  evaluated: readonly CandidateEvaluation[],
): FontCandidateRejectionAuditV2[] {
  const order = new Map(evaluated.map((entry, index) => [entry.fontId, index]));
  return [...state.rejections.entries()]
    .flatMap(([fontId, byKind]) => buildFontRejections(fontId, byKind))
    .sort((left, right) => compareRejections(left, right, order));
}

function buildFontRejections(
  fontId: string,
  byKind: Map<"hard" | "policy", Set<string>>,
): FontCandidateRejectionAuditV2[] {
  return (["hard", "policy"] as const).flatMap((kind) => {
    const reasons = byKind.get(kind);
    return reasons
      ? [
          {
            fontId,
            kind,
            reasonCodes: [...reasons].sort(compareStrings),
          } as FontCandidateRejectionAuditV2,
        ]
      : [];
  });
}

function compareRejections(
  left: FontCandidateRejectionAuditV2,
  right: FontCandidateRejectionAuditV2,
  order: ReadonlyMap<string, number>,
): number {
  return (
    (order.get(left.fontId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.fontId) ?? Number.MAX_SAFE_INTEGER) ||
    compareStrings(left.fontId, right.fontId) ||
    compareStrings(left.kind, right.kind)
  );
}

function compareCandidatesForAudit(
  left: CandidateEvaluation,
  right: CandidateEvaluation,
): number {
  return (
    (left.originalRank ?? Number.MAX_SAFE_INTEGER) -
      (right.originalRank ?? Number.MAX_SAFE_INTEGER) ||
    compareStrings(left.fontId, right.fontId)
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
