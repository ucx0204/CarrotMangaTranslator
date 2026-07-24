import type { MangaPage } from "../../shared/libraryTypes";
import type {
  ChapterStoryMemory,
  PageStoryMemory,
  WorkStyleGuide,
} from "../../shared/workContextTypes";
import { saveChapterStoryMemory, saveWorkStyleGuide } from "../library";
import { mergeCumulativePageContext } from "./cumulativePageContext";
import { upsertPageStoryMemory } from "./storyMemoryBuilder";
import type {
  OcrBboxResult,
  PageContextPayload,
  PipelineWorkContext,
} from "./types";
import type { WarningCollector } from "./warningCollector";
import { logPipelineWarning } from "./translationAttemptLogging";

export type PageContextPersistenceRepository = {
  saveChapterStoryMemory: (
    memory: ChapterStoryMemory,
  ) => Promise<ChapterStoryMemory>;
  saveWorkStyleGuide: (guide: WorkStyleGuide) => Promise<WorkStyleGuide>;
};

export type PageContextPersistenceLogger = {
  warn: (message: string, detail?: unknown) => void;
};

export type PageContextPersistenceDependencies = {
  repository: PageContextPersistenceRepository;
  logger: PageContextPersistenceLogger;
};

const defaultDependencies: PageContextPersistenceDependencies = {
  repository: { saveChapterStoryMemory, saveWorkStyleGuide },
  logger: { warn: logPipelineWarning },
};

type PersistPageContextInput = {
  page?: MangaPage;
  pageIndex: number;
  pageContext?: PageContextPayload;
  ocrResult?: OcrBboxResult;
  collectPageContext: boolean;
  warningCollector: WarningCollector;
  workContext?: PipelineWorkContext;
};

export async function persistPageContextAfterSuccess(
  {
    page,
    pageIndex,
    pageContext,
    ocrResult,
    collectPageContext,
    warningCollector,
    workContext,
  }: PersistPageContextInput,
  dependencies: PageContextPersistenceDependencies = defaultDependencies,
): Promise<void> {
  if (!workContext || !page || page.analysisStatus !== "completed") {
    return;
  }
  const existing = workContext.storyMemory.pages.find(
    (entry) => entry.pageId === page.id,
  );
  const pageMemory = collectPageContext
    ? await buildAndPersistCumulativeMemory({
        page,
        pageIndex,
        pageContext,
        ocrResult,
        existing,
        dependencies,
        warningCollector,
        workContext,
      })
    : mergeCumulativePageContext({
        styleGuide: workContext.styleGuide,
        existingPageMemory: existing,
        page,
        pageIndex,
        ocrResult,
      }).pageMemory;
  workContext.storyMemory = upsertPageStoryMemory(
    workContext.storyMemory,
    pageMemory,
  );
  try {
    workContext.storyMemory =
      await dependencies.repository.saveChapterStoryMemory(
        workContext.storyMemory,
      );
  } catch (error) {
    addContextSaveWarning(
      warningCollector,
      dependencies.logger,
      page,
      "페이지 기억",
      error,
    );
  }
}

async function buildAndPersistCumulativeMemory({
  page,
  pageIndex,
  pageContext,
  ocrResult,
  existing,
  dependencies,
  warningCollector,
  workContext,
}: {
  page: MangaPage;
  pageIndex: number;
  pageContext?: PageContextPayload;
  ocrResult?: OcrBboxResult;
  existing?: PageStoryMemory;
  dependencies: PageContextPersistenceDependencies;
  warningCollector: WarningCollector;
  workContext: PipelineWorkContext;
}): Promise<PageStoryMemory> {
  const merged = mergeCumulativePageContext({
    styleGuide: workContext.styleGuide,
    existingPageMemory: existing,
    page,
    pageIndex,
    pageContext,
    ocrResult,
  });
  warningCollector.add(...merged.warnings);
  if (!merged.guideChanged) {
    workContext.styleGuide = merged.styleGuide;
    return merged.pageMemory;
  }
  try {
    workContext.styleGuide = await dependencies.repository.saveWorkStyleGuide(
      merged.styleGuide,
    );
    return merged.pageMemory;
  } catch (error) {
    addContextSaveWarning(
      warningCollector,
      dependencies.logger,
      page,
      "용어/캐릭터 기억",
      error,
    );
    return mergeCumulativePageContext({
      styleGuide: workContext.styleGuide,
      existingPageMemory: existing,
      page,
      pageIndex,
      pageContext: pageContext
        ? { ...pageContext, glossary: [], characters: [] }
        : undefined,
      ocrResult,
    }).pageMemory;
  }
}

function addContextSaveWarning(
  warningCollector: WarningCollector,
  logger: PageContextPersistenceLogger,
  page: MangaPage,
  kind: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  warningCollector.add(
    `${page.name}: ${kind} 저장에 실패했지만 번역 결과는 유지했습니다. ${message}`,
  );
  logger.warn("Cumulative page context save failed", {
    pageId: page.id,
    pageName: page.name,
    kind,
    error,
  });
}
