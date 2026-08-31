import type {
  FontMatchingSemanticRole,
  FontMatchingSourceStyleV2,
} from "../../shared/fontMatchingProfileTypes";
import type { FontContinuityObservation } from "../../shared/translationCheckpoint";

const MAXIMUM_OBSERVATIONS_PER_ROLE = 96;
const BODY_PRIOR_ROLES = new Set<FontMatchingSemanticRole>([
  "dialogue",
  "narration",
  "thought",
]);

export type BodyFontObservation = Readonly<{
  evidenceKey: string;
  pageId: string;
  blockId: string;
  fontId: string;
  confidence: number;
  orientation: "horizontal" | "vertical";
  sourceStyle: FontMatchingSourceStyleV2;
  modelVersion: string;
  candidateOrderSha256: string;
}>;

export function appendBodyObservation(
  observationsByRole: Map<FontMatchingSemanticRole, BodyFontObservation[]>,
  role: FontMatchingSemanticRole,
  observation: BodyFontObservation,
): void {
  const observations = observationsByRole.get(role) ?? [];
  if (
    observations.some((entry) => entry.evidenceKey === observation.evidenceKey)
  ) {
    return;
  }
  observations.push(observation);
  if (observations.length > MAXIMUM_OBSERVATIONS_PER_ROLE) {
    observations.splice(0, observations.length - MAXIMUM_OBSERVATIONS_PER_ROLE);
  }
  observationsByRole.set(role, observations);
}

export function hydrateBodyContinuity(
  observationsByRole: Map<FontMatchingSemanticRole, BodyFontObservation[]>,
  observations: readonly FontContinuityObservation[],
): void {
  for (const observation of observations) {
    if (!BODY_PRIOR_ROLES.has(observation.role)) continue;
    appendBodyObservation(observationsByRole, observation.role, {
      evidenceKey: `${observation.pageId}\u0000${observation.blockId}`,
      pageId: observation.pageId,
      blockId: observation.blockId,
      fontId: observation.selectedFontId,
      confidence: observation.confidence,
      orientation: observation.orientation,
      sourceStyle: observation.sourceStyle,
      modelVersion: observation.modelVersion,
      candidateOrderSha256: observation.candidateOrderSha256,
    });
  }
}

export function snapshotBodyContinuity(
  observationsByRole: ReadonlyMap<
    FontMatchingSemanticRole,
    readonly BodyFontObservation[]
  >,
  pageId: string,
): readonly FontContinuityObservation[] {
  return [...observationsByRole].flatMap(([role, observations]) =>
    observations
      .filter((observation) => observation.pageId === pageId)
      .map((observation) => ({
        pageId: observation.pageId,
        blockId: observation.blockId,
        role,
        selectedFontId: observation.fontId,
        confidence: observation.confidence,
        orientation: observation.orientation,
        sourceStyle: observation.sourceStyle,
        modelVersion: observation.modelVersion,
        candidateOrderSha256: observation.candidateOrderSha256,
      })),
  );
}
