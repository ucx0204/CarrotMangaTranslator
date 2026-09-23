import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { WorkflowRecognitionSegmentSchema } from "../../shared/pageWorkflowBlockMetadata";
import { join } from "node:path";
import type { MangaPage } from "../../shared/libraryTypes";
import type { PageWorkflowPlan } from "../../shared/pageWorkflowTypes";
import { pixelsToBbox } from "../../shared/bboxNormalization";
import {
  workflowRegionKey,
  workflowStageKey,
  workflowTargetBlocks,
} from "../../shared/pageWorkflowPolicy";
import { overlayItemToBlock } from "../pipeline/overlayItems";
import { prepareHayaiRegions } from "../textDetection/hayaiRegionPrepass";
import type { HayaiRegionManifest } from "../textDetection/hayaiRegionGeometry";
import type { TranslationOptions } from "../appSettings";
import type { TranslationRuntimePort } from "../pipeline/translationRuntimePort";
import { buildKeepBlocksOcrResult } from "../pipeline/keepBlocksResult";

export async function detectWorkflowBlocks(
  page: MangaPage,
  options: TranslationOptions,
  plan: PageWorkflowPlan,
  detect: typeof prepareHayaiRegions = prepareHayaiRegions,
): Promise<MangaPage> {
  if (page.blocks.length && !plan.overwrite.includes("detect")) return page;
  if (
    !plan.overwrite.includes("detect") &&
    page.pageWorkflow?.emptyDetectionKey === workflowStageKey(page, "detect")
  )
    return page;
  const { manifest } = await detect(options);
  const detectionId = randomUUID();
  const blocks = manifest.dialogueRegions.map((region, index) => {
    const block = overlayItemToBlock(
      {
        id: region.id,
        type: "nonsolid",
        textRole: "ordinary",
        jp: "",
        ko: "",
        bbox: normalizedRegion(region.bbox, page),
        confidence: region.detectorConfidence,
      },
      page,
      index,
      detectionId,
      options.blockFormatDefaults,
    );
    return {
      ...block,
      textDisplayMode: "translation-only" as const,
      workflowOrigin: {
        geometryKey: workflowRegionKey(page, block),
        recognitionBboxes: region.recognitionBboxes,
        initialFontSize: block.fontSizePx,
        initialFontFamily: block.fontFamily,
        initialFontStyle: {
          bold: block.bold,
          italic: block.italic,
          fontWeight: block.fontWeight,
          textColor: block.textColor,
          outlineColor: block.outlineColor,
        },
      },
    };
  });
  return {
    ...page,
    blocks,
    blockOrder: blocks.map((block) => block.id),
    analysisStatus: "idle",
    translationCheckpoint: undefined,
    translationCompletion: undefined,
    soundEffectReview: {
      contractVersion: 3,
      producer: "hayai-regions-v1",
      regionOverrides: [],
      manualRegions: [],
      resolvedRegions: [],
      regions: manifest.effectRegions.map((region) => ({
        id: region.regionId,
        bbox: normalizedRegion(region.bbox, page),
        detectorConfidence: region.detectorConfidence,
        sourceDetectionIds: region.sourceDetectionIds,
      })),
    },
  };
}

export async function readWorkflowSource(
  page: MangaPage,
  options: TranslationOptions,
  plan: PageWorkflowPlan,
  runtime: TranslationRuntimePort,
): Promise<MangaPage> {
  const targets = workflowTargetBlocks(page, "ocr", plan);
  if (!targets.length) return page;
  if (!runtime.collectPreparedHayaiHints)
    throw new Error("HayaiOCR 고정 영역 판독을 사용할 수 없습니다.");
  const manifest = manifestForBlocks(page, targets);
  await mkdir(options.outputDir, { recursive: true });
  const path = join(options.outputDir, "workflow-regions.json");
  await writeFile(path, JSON.stringify(manifest), "utf8");
  const result = await runtime.collectPreparedHayaiHints({
    ...options,
    ocrBboxRegionsPath: path,
  });
  const hints = z
    .array(
      z.object({
        id: z.number().int().positive(),
        ocrText: z.string().default(""),
        recognitionSegments: z
          .array(WorkflowRecognitionSegmentSchema)
          .optional(),
      }),
    )
    .parse(result.hints);
  const byId = new Map(hints.map((hint) => [hint.id, hint]));
  const recognized = new Map(
    targets.map((block, index) => [block.id, byId.get(index + 1)]),
  );
  if (targets.some((block) => !recognized.get(block.id)))
    throw new Error("일부 블록의 OCR 결과가 누락되었습니다.");
  return {
    ...page,
    blocks: page.blocks.map((block) => {
      const hint = recognized.get(block.id);
      if (!hint) return block;
      return {
        ...block,
        sourceText: hint.ocrText,
        ...(block.workflowOrigin
          ? {
              workflowOrigin: {
                ...block.workflowOrigin,
                recognitionSegments: hint.recognitionSegments,
              },
            }
          : {}),
      };
    }),
  };
}

function manifestForBlocks(
  page: MangaPage,
  blocks: MangaPage["blocks"],
): HayaiRegionManifest {
  const hints = buildKeepBlocksOcrResult({ ...page, blocks }).hints as Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }>;
  return {
    schemaVersion: "hayai-dialogue-effect-separated-v1",
    width: page.width,
    height: page.height,
    dialogueRegions: blocks.map((block, index) => ({
      id: index + 1,
      regionId: block.id,
      kind: "dialogue",
      bbox: [
        hints[index].x1,
        hints[index].y1,
        hints[index].x2,
        hints[index].y2,
      ],
      detectorConfidence: block.confidence,
      sourceDetectionIds: [],
      recognitionBboxes:
        block.workflowOrigin?.geometryKey === workflowRegionKey(page, block)
          ? block.workflowOrigin.recognitionBboxes
          : undefined,
    })),
    effectRegions: [],
    diagnostics: {
      dialogueFragmentMerges: 0,
      dialogueOverlapMerges: 0,
      dialogueOverlapCuts: 0,
      dialogueOwnershipSkips: 0,
      rejectedDialogueCount: 0,
      effectOverlapMerges: 0,
      effectOverlapCuts: 0,
      rejectedEffectCount: 0,
    },
  };
}

function normalizedRegion(
  box: [number, number, number, number],
  page: MangaPage,
) {
  return pixelsToBbox(
    { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] },
    page.width,
    page.height,
  );
}
