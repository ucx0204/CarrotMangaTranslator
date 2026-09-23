import type { MangaPage } from "../../shared/libraryTypes";
import { normalizeBboxTo1000 } from "../../shared/bboxNormalization";
import { workflowRegionKey } from "../../shared/pageWorkflowPolicy";
import { buildKeepBlocksOcrResult } from "../pipeline/keepBlocksResult";
import { applyOcrCandidateGeometryLocks } from "../pipeline/overlayOcrGeometryLocks";
import { attachFontMatchingFixedBlockCandidateMembership } from "../pipeline/fontMatchingOcrGeometryDirection";
import type { OverlayItem } from "../pipeline/types";
import { buildKeepBlocksFontInferenceBlocks } from "../pipeline/keepBlocksAssignment";
import { buildPageOptions } from "../pipeline/options";
import { buildPreviousBlocksForPrompt } from "../pipeline/previousBlocksForPrompt";
import type { TranslationOptions } from "../appSettings";
import type { PageWorkflowRuntimeContext } from "./pageWorkflowRuntimeTypes";
import type { PreparedPageBuildResult } from "../pipeline/pageResultBuilder";

export function prepareWorkflowTypographyPage(
  page: MangaPage,
  index: number,
  base: TranslationOptions,
  context: PageWorkflowRuntimeContext,
): Extract<PreparedPageBuildResult, { kind: "translated" }> {
  const pageOptions = buildPageOptions(base, page, index, 1);
  pageOptions.keepBlocksMode = true;
  pageOptions.fontSizeAutoFit = context.plan.autoSize;
  pageOptions.abortSignal = context.signal;
  const hints = workflowOcrHints(page).hints;
  pageOptions.ocrBboxHints = hints;
  pageOptions.previousBlocksForPrompt = buildPreviousBlocksForPrompt(
    page,
    hints,
    { assignSequentialCandidateIds: true },
  );
  const items = workflowOverlayItems(page);
  return {
    kind: "translated",
    jobId: context.runId,
    page,
    pageOptions,
    items,
    fontInferenceItems: items,
    keepBlocksInferenceBlocks: buildKeepBlocksFontInferenceBlocks({
      page,
      items,
      previousBlocks: pageOptions.previousBlocksForPrompt,
    }),
    soundDroppedCount: 0,
    validationDroppedCount: 0,
    validationReasons: {},
    remappedCount: 0,
    contextWarnings: [],
  };
}

function workflowOcrHints(page: MangaPage) {
  const result = buildKeepBlocksOcrResult(
    page,
    page.blocks.map((b) => b.sourceText),
  );
  return {
    ...result,
    hints: result.hints.map((hint, index) => ({
      ...(hint as Record<string, unknown>),
      recognitionSegments:
        page.blocks[index].workflowOrigin?.geometryKey ===
        workflowRegionKey(page, page.blocks[index])
          ? page.blocks[index].workflowOrigin?.recognitionSegments
          : undefined,
    })),
  };
}

function workflowOverlayItems(page: MangaPage): OverlayItem[] {
  const items: OverlayItem[] = page.blocks.map((block, index) => ({
    id: index + 1,
    candidateIds: [index + 1],
    type: "nonsolid",
    bbox: normalizeBboxTo1000(block.bbox, page, block.bboxSpace),
    jp: block.sourceText,
    ko: block.translatedText,
    confidence: block.confidence,
    textRole: block.textRole,
    fontRole: block.fontRole,
    fontRoleConfidence: block.fontRoleConfidence,
    visualClusterId: block.visualClusterId,
    direction: block.sourceDirection,
  }));
  return attachFontMatchingFixedBlockCandidateMembership(
    applyOcrCandidateGeometryLocks(items, page, workflowOcrHints(page).hints),
    {
      fixedBlockTranslationVersion: 6,
      fixedBlockIds: items.map(
        (_, index) => `B${String(index + 1).padStart(3, "0")}`,
      ),
      fixedBlockCandidateIds: items.map((item) => [item.id]),
      fixedBlockDirectionVoterCandidateIds: items.map((item) => [item.id]),
    },
  );
}
