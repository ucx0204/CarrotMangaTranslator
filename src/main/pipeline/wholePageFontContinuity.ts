import { normalizeBboxTo1000 } from "../../shared/bboxNormalization";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  FONT_CONTINUITY_RUNTIME_CONTRACT,
  FONT_CONTINUITY_SCHEMA_VERSION,
  type FontContinuityObservation,
} from "../../shared/translationCheckpoint";
import { candidateOrderSha256 } from "./autoMatchActiveCatalogContract";
import type { AutomaticFontPageCoordinatorV2 } from "./automaticFontMatchingV2PageCoordinator";
import { throwIfAborted } from "./failure";
import {
  USER_PAGE_FONT_MATCHING_BOUNDARY,
  type VerifiedAutomaticFontPixelInferenceV2,
} from "./fontMatchingPagePixelInferenceTypes";
import { prepareAnalysisRun } from "./prepareAnalysisRun";
import type { WholePagePipelineDependencies } from "./wholePagePipelinePorts";

type PreparedBaseOptions = Awaited<
  ReturnType<typeof prepareAnalysisRun>
>["baseOptions"];

type ContinuityOptions = Readonly<{
  candidates?: PreparedBaseOptions["fontMatchingCandidates"];
  coordinator?: AutomaticFontPageCoordinatorV2;
  dependencies: Pick<WholePagePipelineDependencies, "diagnostics">;
  pageInference?: WholePagePipelineDependencies["fontMatching"]["pageInference"];
  pages?: readonly MangaPage[];
  selectedPageIds: ReadonlySet<string>;
  signal: AbortSignal;
  targetLanguage?: string;
}>;

export function buildFontContinuityMetadata(
  observations: readonly FontContinuityObservation[],
): MangaPage["fontContinuity"] {
  return observations.length > 0
    ? {
        schemaVersion: FONT_CONTINUITY_SCHEMA_VERSION,
        runtimeContractVersion: FONT_CONTINUITY_RUNTIME_CONTRACT,
        observations,
        savedAt: new Date().toISOString(),
      }
    : undefined;
}

export async function hydrateFontContinuityBeforePage(
  options: ContinuityOptions & {
    beforePageId: string;
    startIndex: number;
  },
): Promise<number> {
  const { coordinator, pages, beforePageId, startIndex } = options;
  if (!coordinator || !pages?.length) return startIndex;
  const selectedIndex = pages.findIndex((page) => page.id === beforePageId);
  if (selectedIndex < 0) return startIndex;
  const catalog = createCatalogFilter(options.candidates);
  for (let index = startIndex; index < selectedIndex; index += 1) {
    const page = pages[index];
    if (!page || !shouldRestorePage(page, options.selectedPageIds)) continue;
    throwIfAborted(options.signal);
    await restorePageContinuity(page, coordinator, catalog, options);
  }
  return selectedIndex + 1;
}

function createCatalogFilter(candidates: ContinuityOptions["candidates"]): {
  candidateIds: ReadonlySet<string>;
  candidateOrderHash?: string;
} {
  return {
    candidateIds: new Set(candidates?.map((candidate) => candidate.fontId)),
    candidateOrderHash: candidates?.length
      ? candidateOrderSha256(candidates.map((candidate) => candidate.fontId))
      : undefined,
  };
}

function shouldRestorePage(
  page: MangaPage,
  selectedPageIds: ReadonlySet<string>,
): boolean {
  return page.analysisStatus === "completed" && !selectedPageIds.has(page.id);
}

async function restorePageContinuity(
  page: MangaPage,
  coordinator: AutomaticFontPageCoordinatorV2,
  catalog: ReturnType<typeof createCatalogFilter>,
  options: ContinuityOptions,
): Promise<void> {
  const stored = readCompatibleStoredObservations(page, catalog);
  if (stored.length > 0) {
    coordinator.hydrateContinuity?.(stored);
    return;
  }
  if (!options.pageInference || !options.candidates?.length) return;
  try {
    const inferred = await inferReadOnlyFontContinuity({
      candidates: options.candidates,
      page,
      pageInference: options.pageInference,
      signal: options.signal,
      targetLanguage: options.targetLanguage,
    });
    coordinator.hydrateContinuity?.(inferred);
  } catch (error) {
    throwIfAborted(options.signal);
    options.dependencies.diagnostics.warn(
      "Read-only predecessor font continuity inference failed",
      { pageId: page.id, error },
    );
  }
}

function readCompatibleStoredObservations(
  page: MangaPage,
  catalog: ReturnType<typeof createCatalogFilter>,
): readonly FontContinuityObservation[] {
  const continuity = page.fontContinuity;
  if (
    continuity?.schemaVersion !== FONT_CONTINUITY_SCHEMA_VERSION ||
    continuity.runtimeContractVersion !== FONT_CONTINUITY_RUNTIME_CONTRACT
  ) {
    return [];
  }
  return continuity.observations.filter(
    (observation) =>
      observation.pageId === page.id &&
      catalog.candidateIds.has(observation.selectedFontId) &&
      observation.candidateOrderSha256 === catalog.candidateOrderHash,
  );
}

async function inferReadOnlyFontContinuity({
  candidates,
  page,
  pageInference,
  signal,
  targetLanguage,
}: {
  candidates: NonNullable<ContinuityOptions["candidates"]>;
  page: MangaPage;
  pageInference: NonNullable<ContinuityOptions["pageInference"]>;
  signal: AbortSignal;
  targetLanguage?: string;
}): Promise<readonly FontContinuityObservation[]> {
  const blocks = page.blocks.map((block, index) => ({
    blockId: block.id,
    item: {
      id: index + 1,
      type: "text",
      textRole: block.textRole,
      fontRole: block.fontRole,
      fontRoleConfidence: block.fontRoleConfidence,
      bbox: normalizeBboxTo1000(
        block.bbox,
        { width: page.width, height: page.height },
        block.bboxSpace,
      ),
      jp: block.sourceText,
      ko: block.translatedText,
      sourceText: block.sourceText,
      translatedText: block.translatedText,
      direction: block.sourceDirection,
    },
  }));
  if (blocks.length === 0) return [];
  const result = await pageInference.inferPage({
    page,
    blocks,
    candidates,
    targetLanguage,
    boundary: USER_PAGE_FONT_MATCHING_BOUNDARY,
    signal,
  });
  return [...result.pixelInferenceByBlockId.values()].flatMap(toObservation);
}

function toObservation(
  inference: VerifiedAutomaticFontPixelInferenceV2,
): FontContinuityObservation[] {
  const localTop = [...inference.localEvidence.rankedCandidates]
    .filter((candidate) => candidate.renderStatus === "rendered")
    .sort((left, right) => left.rank - right.rank)[0];
  const confidence = Math.min(
    inference.localEvidence.calibratedConfidence,
    localTop?.confidence ?? 0,
  );
  if (
    !localTop ||
    inference.localEvidence.noneAcceptable ||
    confidence < 0.86 ||
    inference.rolePrediction.confidence < 0.82
  ) {
    return [];
  }
  return [
    {
      pageId: inference.pageId,
      blockId: inference.blockId,
      role: inference.rolePrediction.primary,
      selectedFontId: localTop.fontId,
      confidence,
      orientation: inference.treatment.orientation,
      sourceStyle: inference.sourceStyle,
      modelVersion: inference.modelVersion,
      candidateOrderSha256: inference.candidateOrderSha256,
    },
  ];
}
