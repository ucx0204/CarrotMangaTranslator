import { hashStableValue } from "./blockFingerprint";
import type { MangaPage, ChapterSnapshot } from "./libraryTypes";
import {
  type PageWorkflowPlan,
  type PageWorkflowRequest,
  type PageWorkflowPreflight,
} from "./pageWorkflowTypes";
import {
  PAGE_WORKFLOW_STAGES,
  type PageWorkflowStage,
} from "./pageWorkflowStages";

export function workflowRegionKey(
  page: MangaPage,
  block: MangaPage["blocks"][number],
): string {
  return hashStableValue([
    page.imagePath,
    page.width,
    page.height,
    block.bbox,
    block.bboxSpace,
  ]);
}

export function workflowStageKey(
  page: MangaPage,
  stage: PageWorkflowStage,
): string {
  const geometry = page.blocks.map((block) => [
    block.id,
    workflowRegionKey(page, block),
  ]);
  if (stage === "detect") return hashStableValue([page.imagePath, geometry]);
  if (stage === "erase")
    return hashStableValue([
      geometry,
      page.blocks.map((b) => b.inpaintExcluded),
      page.inpaintedImagePath,
      page.erasedWorkflowRegions,
    ]);
  if (stage === "ocr" || stage === "source-rules")
    return hashStableValue([geometry, page.blocks.map((b) => b.sourceText)]);
  if (stage === "translate" || stage === "translation-rules")
    return hashStableValue([
      geometry,
      page.blockOrder,
      page.blocks.map((b) => [b.sourceText, b.translatedText]),
    ]);
  return hashStableValue([
    geometry,
    page.blocks,
    stage === "layout" ? page.inpaintedImagePath : undefined,
  ]);
}

export function workflowTargetBlocks(
  page: MangaPage,
  stage: PageWorkflowStage,
  plan: PageWorkflowPlan,
) {
  const overwrite = plan.overwrite.includes(stage);
  if (stage === "ocr")
    return page.blocks.filter((block) => overwrite || !block.sourceText.trim());
  if (stage === "translate")
    return page.blocks.filter(
      (block) =>
        Boolean(block.sourceText.trim()) &&
        (overwrite || !block.translatedText.trim()),
    );
  if (stage === "erase")
    return page.blocks.filter(
      (block) =>
        !block.inpaintExcluded &&
        (overwrite ||
          !page.inpaintedImagePath ||
          page.erasedWorkflowRegions?.[block.id] !==
            workflowRegionKey(page, block)),
    );
  if (stage === "layout")
    return page.blocks.filter((block) => overwrite || !block.bubbleLayout);
  if (stage === "typography")
    return page.blocks.filter((block) => {
      const fields = workflowTypographyFields(block, plan);
      return fields.font || fields.size;
    });
  return page.blocks;
}

export function workflowTypographyFields(
  block: MangaPage["blocks"][number],
  plan: PageWorkflowPlan,
) {
  const overwrite = plan.overwrite.includes("typography");
  const origin = block.workflowOrigin;
  return {
    font:
      plan.autoFont &&
      (overwrite ||
        !block.fontFamily ||
        Boolean(
          origin &&
          !origin.fontApplied &&
          block.fontFamily === origin.initialFontFamily,
        )),
    size:
      plan.autoSize &&
      (overwrite ||
        Boolean(
          origin &&
          !origin.sizeApplied &&
          block.fontSizeIntent !== "manual" &&
          block.fontSizePx === origin.initialFontSize,
        )),
  };
}

export function preflightPageWorkflow(
  request: PageWorkflowRequest,
  chapters: ChapterSnapshot[],
): PageWorkflowPreflight {
  const result: PageWorkflowPreflight = {
    issues: [],
    counts: [],
    pageCount: 0,
  };
  const pages = collectWorkflowPages(request, chapters, result);
  result.pageCount = pages.length;
  for (const stage of PAGE_WORKFLOW_STAGES.filter((id) =>
    request.plan.stages.includes(id),
  )) {
    const count = { stage, process: 0, preserve: 0, empty: 0 };
    for (const target of pages) {
      const issue = workflowPrerequisiteIssue(target.page, stage, request.plan);
      if (issue)
        result.issues.push({
          chapterId: target.chapterId,
          pageId: target.page.id,
          stage,
          message: issue,
        });
      count[workflowPageDisposition(target.page, stage, request.plan)] += 1;
    }
    result.counts.push(count);
  }
  return result;
}

function workflowPrerequisiteIssue(
  page: MangaPage,
  stage: PageWorkflowStage,
  plan: PageWorkflowPlan,
): string | undefined {
  if (stage === "detect") return;
  const willDetect = plan.stages.includes("detect");
  if (
    !page.blocks.length &&
    !plan.overwrite.includes("detect") &&
    page.pageWorkflow?.emptyDetectionKey === workflowStageKey(page, "detect")
  )
    return;
  if (page.blocks.length === 0 && !willDetect)
    return "블록이 없습니다. 블록 검출을 선택하거나 이 페이지를 제외하세요.";
  return workflowTextPrerequisite(page, stage, plan, willDetect);
}

function missingWorkflowTranslation(
  page: MangaPage,
  plan: PageWorkflowPlan,
  willDetect: boolean,
) {
  return (
    (willDetect &&
      (!page.blocks.length || plan.overwrite.includes("detect"))) ||
    workflowTargetBlocks(page, "layout", plan).some(
      (block) => !block.translatedText.trim(),
    )
  );
}

function collectWorkflowPages(
  request: PageWorkflowRequest,
  chapters: ChapterSnapshot[],
  result: PageWorkflowPreflight,
) {
  const pages: Array<{ chapterId: string; page: MangaPage }> = [];
  for (const selection of request.selection) {
    const chapter = chapters.find((item) => item.id === selection.chapterId);
    for (const pageId of new Set(selection.pageIds)) {
      const page = chapter?.pages.find((item) => item.id === pageId);
      if (page) pages.push({ chapterId: selection.chapterId, page });
      else
        result.issues.push({
          chapterId: selection.chapterId,
          pageId,
          message: "페이지를 찾지 못했습니다.",
        });
    }
  }

  return pages;
}

function workflowPageDisposition(
  page: MangaPage,
  stage: PageWorkflowStage,
  plan: PageWorkflowPlan,
): "empty" | "preserve" | "process" {
  if (
    !page.blocks.length &&
    page.pageWorkflow?.emptyDetectionKey === workflowStageKey(page, "detect") &&
    !plan.overwrite.includes("detect")
  )
    return "empty";
  if (stage === "detect")
    return page.blocks.length > 0 && !plan.overwrite.includes(stage)
      ? "preserve"
      : "process";
  return page.blocks.length > 0 &&
    workflowTargetBlocks(page, stage, plan).length === 0
    ? "preserve"
    : "process";
}

function missingWorkflowSource(
  page: MangaPage,
  plan: PageWorkflowPlan,
  willDetect: boolean,
) {
  if (willDetect && (!page.blocks.length || plan.overwrite.includes("detect")))
    return true;
  return page.blocks.some(
    (block) =>
      !block.sourceText.trim() &&
      (plan.overwrite.includes("translate") || !block.translatedText.trim()),
  );
}

function workflowTextPrerequisite(
  page: MangaPage,
  stage: PageWorkflowStage,
  plan: PageWorkflowPlan,
  willDetect: boolean,
) {
  if (
    stage === "layout" &&
    !plan.stages.includes("translate") &&
    missingWorkflowTranslation(page, plan, willDetect)
  )
    return "번역문이 없습니다. 번역 또는 번역문 입력이 필요합니다.";
  if (stage !== "translate") return;
  if (plan.stages.includes("ocr")) return;
  if (missingWorkflowSource(page, plan, willDetect))
    return "번역할 원문이 없습니다. 원문 읽기 또는 원문 입력이 필요합니다.";
}
