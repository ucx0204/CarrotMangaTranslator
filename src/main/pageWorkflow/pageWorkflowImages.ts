import type { MangaPage } from "../../shared/libraryTypes";
import { PageWorkflowPartialFailure } from "../application/pageWorkflowPartialFailure";
import {
  workflowRegionKey,
  workflowTargetBlocks,
} from "../../shared/pageWorkflowPolicy";
import { acquireInpaintingEngine } from "../inpainting/inpaintingEnginePool";
import { acquireCodexInpaintingEngine } from "../inpainting/codexInpaintingEngine";
import { inpaintPatternPage } from "../inpainting/patternPage";
import { createProductionBubbleLayoutRunner } from "../bubbleLayout/bubbleLayoutFacade";
import { runBubbleLayoutMaskPrepass } from "../jobs/bubbleLayoutJob";
import { runBubbleLayoutPostprocess } from "../inpainting/bubbleLayoutRunner";
import { applyInpaintingLayoutStates } from "../inpainting/inpaintingLayoutState";
import { applyNaturalTextLayout } from "../../shared/naturalTextLayout";
import type { PageWorkflowRuntimeContext } from "./pageWorkflowRuntimeTypes";

function workflowBubbleRunner(context: PageWorkflowRuntimeContext) {
  return createProductionBubbleLayoutRunner({
    dataRoot: context.paths.dataRoot,
    decodeFallback: context.decodeImage,
    directMl: {
      ...context.settings.hardware,
      computeGpuBackend: context.settings.ocr.gpuBackend,
    },
  });
}

export async function eraseWorkflowPage(
  context: PageWorkflowRuntimeContext,
  page: MangaPage,
): Promise<MangaPage> {
  const targets = workflowTargetBlocks(page, "erase", context.plan);
  if (!targets.length) return page;
  const lease = await acquireWorkflowErasure(context);
  try {
    const blockIds = targets.map((block) => block.id);
    const prepass =
      lease.engine.model === "flux-klein" &&
      context.plan.bubbleLayout &&
      context.plan.stages.includes("layout")
        ? await runBubbleLayoutMaskPrepass({
            page,
            blockIds,
            config: { policy: "balanced", overwriteManual: false },
            runner: workflowBubbleRunner(context),
            signal: context.signal,
          })
        : { page };
    const result = await inpaintPatternPage(prepass.page, {
      blockIds,
      signal: context.signal,
      inpaintingEngine: lease.engine,
      decodeFallback: context.decodeImage,
      preserveExistingInpainting: true,
      ...("bubbleLayoutConstraintBlockIds" in prepass
        ? {
            bubbleLayoutConstraintBlockIds:
              prepass.bubbleLayoutConstraintBlockIds,
          }
        : {}),
      ...("sharedInpaintGroupIdsByBlock" in prepass
        ? { sharedInpaintGroupIdsByBlock: prepass.sharedInpaintGroupIdsByBlock }
        : {}),
      ...("typographySegmentation" in prepass
        ? { typographySegmentation: prepass.typographySegmentation }
        : {}),
    });
    const erased = new Set(result.erasedBlockIds);
    const output =
      "restoreLayout" in prepass && prepass.restoreLayout
        ? applyInpaintingLayoutStates(result.page, prepass.restoreLayout)
        : result.page;
    const committed = {
      ...output,
      erasedWorkflowRegions: {
        ...page.erasedWorkflowRegions,
        ...Object.fromEntries(
          targets
            .filter((block) => erased.has(block.id))
            .map((block) => [block.id, workflowRegionKey(page, block)]),
        ),
      },
    };
    if (result.incompleteBlockIds?.length)
      throw new PageWorkflowPartialFailure(
        `${result.incompleteBlockIds.length}개 영역의 원문 제거가 완료되지 않았습니다.`,
        committed,
      );
    return committed;
  } finally {
    await lease.release();
  }
}

export async function layoutWorkflowPage(
  context: PageWorkflowRuntimeContext,
  page: MangaPage,
): Promise<MangaPage> {
  let output = page;
  if (context.plan.bubbleLayout) {
    const blockIds = workflowTargetBlocks(page, "layout", context.plan).map(
      (block) => block.id,
    );
    if (blockIds.length)
      output = (
        await runBubbleLayoutPostprocess({
          page,
          blockIds,
          runner: workflowBubbleRunner(context),
          signal: context.signal,
          config: {
            policy: "balanced",
            overwriteManual: context.plan.overwrite.includes("layout"),
            naturalTextLayout: context.plan.naturalLayout
              ? { locale: context.settings.translation?.targetLanguage }
              : undefined,
          },
        })
      ).page;
  } else if (context.plan.naturalLayout) {
    const targets = new Set(
      workflowTargetBlocks(page, "layout", context.plan).map(
        (block) => block.id,
      ),
    );
    output = {
      ...page,
      blocks: page.blocks.map((block) =>
        targets.has(block.id) && block.translatedText.trim()
          ? {
              ...block,
              translatedText: applyNaturalTextLayout(block, {
                enabled: true,
                pageSize: { width: page.width, height: page.height },
                locale: context.settings.translation?.targetLanguage,
              }).translatedText,
            }
          : block,
      ),
    };
  }
  return output;
}

async function acquireWorkflowErasure(context: PageWorkflowRuntimeContext) {
  const settings = context.settings;
  return context.plan.erasureEngine === "codex"
    ? await acquireCodexInpaintingEngine(
        context.paths,
        settings,
        context.signal,
      )
    : await acquireInpaintingEngine({
        appPaths: context.paths,
        signal: context.signal,
        model: settings.inpainting?.model ?? "flux-klein",
        fluxBackend: settings.inpainting?.fluxBackend,
        koharuBackend: settings.inpainting?.koharuBackend,
        computeGpuIndex: settings.hardware?.computeGpuIndex,
        allowUnsafeLowMemoryFlux:
          settings.inpainting?.allowUnsafeLowMemoryFlux ?? false,
      });
}
