import { resolvePreviousChapterStoryPages } from "../previousChapterContext";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { PageWorkflowStage } from "../../shared/pageWorkflowStages";
import { buildBaseOptions, buildPageOptions } from "../pipeline/options";
import { detectWorkflowBlocks, readWorkflowSource } from "./pageWorkflowOcr";
import { translateWorkflowPage } from "./pageWorkflowTranslation";
import { createWorkflowTypography } from "./pageWorkflowTypography";
import { eraseWorkflowPage, layoutWorkflowPage } from "./pageWorkflowImages";
import { applyWorkflowRuleStage } from "./pageWorkflowRuleExecution";
import type { PageWorkflowRuntimeContext } from "./pageWorkflowRuntimeTypes";
import type { PageWorkflowContextCommit } from "../application/pageWorkflowContextCommit";
import { savePageWorkflowResult } from "../library";

export function createPageWorkflowRuntime(context: PageWorkflowRuntimeContext) {
  const typography = createWorkflowTypography(context);
  let pending: PageWorkflowContextCommit = {};
  let disposal: Promise<void> | undefined;
  context.dependencies.pageContext = {
    saveChapterStoryMemory: async (memory) => {
      pending.storyMemory = memory;
      return memory;
    },
    saveWorkStyleGuide: async (guide) => {
      pending.styleGuide = guide;
      return guide;
    },
  };
  return {
    restoreCompletedStage: async (
      stage: PageWorkflowStage,
      page: MangaPage,
    ) => {
      if (stage === "typography") await typography.apply(page);
    },
    save: async (chapterId: string, before: MangaPage, after: MangaPage) => {
      const commit =
        after.pageWorkflow?.steps.translate?.status === "completed"
          ? pending
          : {};
      await savePageWorkflowResult(chapterId, before, after, commit);
      pending = {};
    },
    prepareStage: async (
      stage: PageWorkflowStage,
      chapter: ChapterSnapshot,
      pageIds: string[],
    ) => {
      if (stage === "translate" && context.plan.cumulative)
        context.previousStoryPages =
          await resolvePreviousChapterStoryPages(chapter);
      if (stage === "typography") await typography.prepare(chapter, pageIds);
    },
    execute: async (
      stage: PageWorkflowStage,
      chapter: ChapterSnapshot,
      page: MangaPage,
    ): Promise<MangaPage> => {
      pending = {};
      if (stage === "detect" || stage === "ocr")
        return executeWorkflowRecognition(context, chapter, page, stage);
      if (!page.blocks.length) return page;
      if (stage === "translate")
        return translateWorkflowPage(context, chapter, page);
      if (stage === "typography") return typography.apply(page);
      if (stage === "erase") return eraseWorkflowPage(context, page);
      if (stage === "layout") return layoutWorkflowPage(context, page);
      return applyWorkflowRuleStage(context, chapter, page, stage);
    },
    dispose: () =>
      (disposal ??= Promise.resolve().then(() =>
        context.dependencies.fontMatching.pageInference?.dispose?.(),
      )),
  };
}

async function executeWorkflowRecognition(
  context: PageWorkflowRuntimeContext,
  chapter: ChapterSnapshot,
  page: MangaPage,
  stage: "detect" | "ocr",
) {
  const paths = await context.runPaths(chapter.id);
  const base = buildBaseOptions(
    context.runId,
    paths.runDir,
    context.settings,
    context.paths,
  );
  const options = buildPageOptions(
    base,
    page,
    chapter.pages.findIndex((p) => p.id === page.id),
    1,
  );
  options.abortSignal = context.signal;
  return stage === "detect"
    ? detectWorkflowBlocks(page, options, context.plan)
    : readWorkflowSource(
        page,
        options,
        context.plan,
        context.dependencies.runtime,
      );
}
