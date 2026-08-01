import type { MangaPage } from "../../shared/libraryTypes";
import type {
  FontMatchingSemanticRole,
  WorkTypographyProfileV2,
} from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { BlockLocalFontEvidenceV2 } from "./fontMatchingDecisionV2";
import type { FontMatchingRuntimeArtifactStatus } from "./fontMatchingRuntimeArtifactStatus";
import { resolveFontMatchingV2CatalogVersion } from "./automaticFontMatchingV2Catalog";

export type VerifiedAutomaticFontPixelInferenceV2 = Readonly<{
  kind: "verified_pixel_inference";
  pageId: string;
  blockId: string;
  modelVersion: string;
  candidateOrderSha256: string;
  localEvidence: BlockLocalFontEvidenceV2;
}>;

export function resolveVerifiedPixelInference({
  block,
  candidates,
  inference,
  page,
  status,
}: {
  block: TranslationBlock;
  candidates: readonly AutomaticFontCandidate[];
  inference?: VerifiedAutomaticFontPixelInferenceV2;
  page: MangaPage;
  status?: FontMatchingRuntimeArtifactStatus;
}): VerifiedAutomaticFontPixelInferenceV2 | null {
  if (status?.state !== "ready" || !inference) return null;
  if (
    !validPixelInferenceIdentity(inference, status, block, page) ||
    !validPixelInferenceEvidence(inference, status, candidates)
  ) {
    return null;
  }
  return inference;
}

export function resolveManualUserLocks(
  profile: WorkTypographyProfileV2 | null,
  workId: string,
  chapterId: string,
  pageId: string,
  blockId: string,
  role: FontMatchingSemanticRole,
) {
  if (!profile || profile.workId !== workId) {
    return { block: null, role: null } as const;
  }
  const block = profile.userLocks.find(
    (lock) =>
      lock.scope.type === "block" &&
      lock.scope.chapterId === chapterId &&
      lock.scope.pageId === pageId &&
      lock.scope.blockId === blockId,
  )?.selection;
  const roleLock = profile.userLocks.find(
    (lock) => lock.scope.type === "role" && lock.scope.role === role,
  )?.selection;
  return { block: block ?? null, role: roleLock ?? null } as const;
}

function validPixelInferenceIdentity(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  status: Extract<FontMatchingRuntimeArtifactStatus, { state: "ready" }>,
  block: TranslationBlock,
  page: MangaPage,
): boolean {
  return (
    status.automaticMutationAllowed &&
    inference.pageId === page.id &&
    inference.blockId === block.id
  );
}

function validPixelInferenceEvidence(
  inference: VerifiedAutomaticFontPixelInferenceV2,
  status: Extract<FontMatchingRuntimeArtifactStatus, { state: "ready" }>,
  candidates: readonly AutomaticFontCandidate[],
): boolean {
  return (
    inference.modelVersion === status.modelVersion &&
    inference.localEvidence.modelVersion === status.modelVersion &&
    inference.candidateOrderSha256 === status.candidateOrderSha256 &&
    inference.localEvidence.catalogVersion ===
      resolveFontMatchingV2CatalogVersion(candidates) &&
    sameCandidateSet(
      inference.localEvidence.rankedCandidates.map((entry) => entry.fontId),
      status.candidateIds,
    )
  );
}

function sameCandidateSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value))
  );
}
