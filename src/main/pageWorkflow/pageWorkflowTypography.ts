import { mergeWorkflowTypography } from "./pageWorkflowTypographyMerge";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { prepareWorkflowTypographyPage } from "./pageWorkflowTypographyInput";
import { createAutomaticFontChapterCoordinatorV2 } from "../pipeline/automaticFontMatchingV2PageCoordinator";
import { configureWholePageOutputOptions } from "../pipeline/wholePageOutputOptions";
import { prepareAnalysisRun } from "../pipeline/prepareAnalysisRun";
import { prepareFontMatchingRuntimeForRun } from "../pipeline/fontMatchingRuntimeAssets";
import {
  finalizePreparedPageResult,
  type PreparedPageBuildResult,
} from "../pipeline/pageResultBuilder";
import type { PageWorkflowRuntimeContext } from "./pageWorkflowRuntimeTypes";
import type { FontChapterC18Resolver } from "../pipeline/fontChapterC18Types";

export function createWorkflowTypography(context: PageWorkflowRuntimeContext) {
  let sourceStyleFor: FontChapterC18Resolver | undefined;
  let coordinator = createAutomaticFontChapterCoordinatorV2();
  const preparedById = new Map<string, PreparedPageBuildResult>();
  return {
    prepare: async (chapter: ChapterSnapshot, pageIds: string[]) => {
      preparedById.clear();
      coordinator = createAutomaticFontChapterCoordinatorV2();
      const pages = chapter.pages.filter(
        (page) => pageIds.includes(page.id) && page.blocks.length > 0,
      );
      if (!pages.length || (!context.plan.autoFont && !context.plan.autoSize))
        return;
      const runPaths = await context.runPaths(chapter.id);
      await prepareFontMatchingRuntimeForRun(
        {
          autoFontMatching: context.plan.autoFont,
          signal: context.signal,
          jobId: context.runId,
          emit: context.emit,
        },
        context.paths,
        false,
      );
      const run = await prepareAnalysisRun({
        jobId: context.runId,
        emit: context.emit,
        pages,
        runPaths,
        runtime: context.dependencies.runtime,
        signal: context.signal,
        skipOcrPrepass: true,
        dependencies: context.dependencies,
      });
      await configureWholePageOutputOptions({
        autoFontMatching: context.plan.autoFont,
        aiFontSizeMatching: context.plan.autoSize,
        chapterId: chapter.id,
        workId: chapter.workId,
        dependencies: context.dependencies,
        naturalTextLayout: false,
        run,
      });
      const inputs = pages.map((page, index) => {
        const prepared = prepareWorkflowTypographyPage(
          page,
          index,
          run.baseOptions,
          context,
        );
        preparedById.set(page.id, prepared);
        return {
          page,
          items: prepared.fontInferenceItems,
          pageOptions: prepared.pageOptions,
        };
      });
      sourceStyleFor = context.plan.autoFont
        ? await context.dependencies.fontMatching.chapter?.prepare(
            inputs,
            context.signal,
          )
        : undefined;
    },
    apply: async (page: MangaPage): Promise<MangaPage> => {
      const prepared = preparedById.get(page.id);
      if (!prepared || !page.blocks.length) return page;
      const result = await finalizePreparedPageResult({
        prepared,
        fontMatchingPageInference:
          context.dependencies.fontMatching.pageInference,
        fontMatchingChapterCoordinator: { ...coordinator, sourceStyleFor },
      });
      return mergeWorkflowTypography(page, result.page, context.plan);
    },
  };
}
