import { createCodexProgressReporter } from "./codexTypesettingProgress";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../../shared/blockFormat";
import { mergeCumulativePageContext } from "./cumulativePageContext";
import { upsertPageStoryMemory } from "./storyMemoryBuilder";
import type { MangaPage } from "../../shared/libraryTypes";
import type { CodexPageReading } from "../../shared/codexTypesettingTypes";
import { prunePromptWorkContextForBudget } from "../../shared/workContextBudget";
import { buildPromptWorkContextForPage } from "./workContextPrompt";
import {
  persistPageContextAfterSuccess,
  type PageContextPersistenceDependencies,
} from "./pageContextPersistence";
import { createWarningCollector } from "./warningCollector";
import type { PipelineOptions } from "./types";

/** Reuse the existing grounded merge and manual-entry authority without extra model turns. */
export function createCodexRunContext(
  options: PipelineOptions,
  dependencies?: PageContextPersistenceDependencies,
) {
  const workContext = options.workContext
    ? structuredClone(options.workContext)
    : undefined;
  const provisional = workContext ? structuredClone(workContext) : undefined;
  const warnings = createWarningCollector();
  const regionOf = (page: MangaPage) =>
    options.regionContext ?? options.regionContexts?.get(page.id);
  const indexOf = (page: MangaPage) =>
    regionOf(page)?.sourcePageIndex ??
    options.canonicalPageIndexById?.get(page.id) ??
    options.pages.findIndex((item) => item.id === page.id);
  const progress = createCodexProgressReporter(
    options.jobId,
    options.pages.length,
    options.emit,
  );
  return {
    progress,
    preview: createPagePreviewReporter(progress),
    warnings: warnings.warnings,
    translationContext: (page: MangaPage): string => {
      if (!provisional) return "";
      return translationContext(
        provisional,
        regionOf(page)?.sourcePage.id ?? page.id,
        indexOf(page),
      );
    },
    rememberReading: (page: MangaPage, reading: CodexPageReading) => {
      if (!provisional) return;
      const merged = mergeCumulativePageContext({
        styleGuide: provisional.styleGuide,
        page: projectReadingPage(page, reading),
        pageIndex: indexOf(page),
        pageContext: pageMemory(reading),
        existingPageMemory: provisional.storyMemory.pages.find(
          (item) => item.pageId === page.id,
        ),
      });
      provisional.styleGuide = merged.styleGuide;
      provisional.storyMemory = upsertPageStoryMemory(
        provisional.storyMemory,
        merged.pageMemory,
      );
      warnings.add(...merged.warnings);
    },
    commit: async (page: MangaPage, reading?: CodexPageReading) => {
      const accepted = await options.onPageComplete?.(page);
      if (
        !options.onPageComplete ||
        accepted === false ||
        options.writeStoryMemory === false ||
        options.regionContext ||
        options.regionContexts ||
        !workContext
      )
        return accepted;
      options.signal.throwIfAborted();
      await persistPageContextAfterSuccess(
        {
          page,
          pageIndex: indexOf(page),
          workContext,
          collectPageContext: true,
          cumulativeContextDetail: options.cumulativeContextDetail,
          warningCollector: warnings,
          pageContext: pageMemory(reading),
        },
        dependencies,
      );
      return accepted;
    },
  };
}

function createPagePreviewReporter(
  progress: ReturnType<typeof createCodexProgressReporter>,
) {
  return (
    page: MangaPage,
    reading: CodexPageReading | undefined,
    stage: "reading" | "background" | "review",
  ) => {
    progress({
      step: stage,
      preview: {
        pageId: page.id,
        name: page.name,
        imagePath:
          stage === "reading"
            ? page.imagePath
            : (page.inpaintedImagePath ?? page.imagePath),
        width: page.width,
        height: page.height,
        stage,
        regions:
          reading?.regions
            .filter((region) => region.action !== "keep")
            .map((region) => ({
              source: region.sourceText,
              translation: region.translatedText,
              bbox: region.sourceBbox,
            })) ?? [],
      },
    });
  };
}

function pageMemory(reading: CodexPageReading | undefined) {
  return {
    visualSummary: reading?.summary,
    glossary: reading?.memory?.glossary ?? [],
    characters: reading?.memory?.characters ?? [],
  };
}

function projectReadingPage(
  page: MangaPage,
  reading: CodexPageReading,
): MangaPage {
  return {
    ...page,
    analysisStatus: "completed",
    blocks: reading.regions
      .filter((region) => region.action !== "keep")
      .map((region) => ({
        ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
        id: region.id,
        type: "nonsolid",
        bbox: region.sourceBbox,
        bboxSpace: "normalized_1000",
        sourceText: region.sourceText,
        translatedText: region.translatedText,
        renderDirection: "horizontal",
        reviewStatus: "draft",
        confidence: 1,
        sourceDirection: region.direction,
        backgroundColor: "#ffffff",
        opacity: 0,
      })),
  };
}

function translationContext(
  contextState: NonNullable<PipelineOptions["workContext"]>,
  pageId: string,
  pageIndex: number,
) {
  const context = buildPromptWorkContextForPage({
    baseStyleGuide: contextState.styleGuide,
    storyMemory: contextState.storyMemory,
    previousStoryPages: contextState.previousStoryPages,
    recentPageCount: contextState.recentPageCount,
    pageId: pageId,
    pageIndex: pageIndex,
  });
  context.styleGuide = {
    ...context.styleGuide,
    glossary: context.styleGuide.glossary.filter((item) => item.enabled),
    characters: context.styleGuide.characters.filter((item) => item.enabled),
  };
  // A local context allowance, independent of the legacy local-model settings.
  const budgeted = prunePromptWorkContextForBudget(context, {
    ctx: 32768,
    maxTokens: 8192,
  });
  return JSON.stringify(budgeted.workContext);
}
