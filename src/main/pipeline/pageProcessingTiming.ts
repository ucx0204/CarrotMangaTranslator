import { performance } from "node:perf_hooks";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  PAGE_PROCESSING_TIMING_STAGES,
  PAGE_PROCESSING_TIMING_VERSION,
  type PageProcessingTimingStage,
} from "../../shared/pageProcessingTiming";

export type PageProcessingTimingCollector = ReturnType<
  typeof createPageProcessingTimingCollector
>;

export function createPageProcessingTimingCollector(
  jobId: string,
  pageIds: readonly string[],
) {
  const uniquePageIds = [...new Set(pageIds)];
  const stagesByPageId = new Map<
    string,
    Partial<Record<PageProcessingTimingStage, number>>
  >();

  const add = (
    pageId: string,
    stage: PageProcessingTimingStage,
    elapsedMs: number,
  ): void => {
    const normalized = normalizeElapsedMs(elapsedMs);
    if (normalized <= 0) return;
    const stages = stagesByPageId.get(pageId) ?? {};
    stages[stage] = (stages[stage] ?? 0) + normalized;
    stagesByPageId.set(pageId, stages);
  };

  const addShared = (
    stage: PageProcessingTimingStage,
    elapsedMs: number,
  ): void => {
    const allocations = distributeIntegerMs(elapsedMs, uniquePageIds.length);
    uniquePageIds.forEach((pageId, index) =>
      add(pageId, stage, allocations[index] ?? 0),
    );
  };

  return {
    add,
    addShared,
    applyInpaintingTiming: (page: MangaPage): MangaPage =>
      applyCollectedTiming(page, stagesByPageId.get(page.id), {
        inpaintingJobId: jobId,
        merge: true,
      }),
    applyTranslationTiming: (page: MangaPage): MangaPage =>
      applyCollectedTiming(page, stagesByPageId.get(page.id), {
        translationJobId: jobId,
        merge: false,
      }),
  };
}

export async function measurePageProcessingStage<T>(
  collector: PageProcessingTimingCollector,
  pageId: string,
  stage: PageProcessingTimingStage,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    collector.add(pageId, stage, performance.now() - startedAt);
  }
}

export async function measureSharedProcessingStage<T>(
  collector: PageProcessingTimingCollector,
  stage: PageProcessingTimingStage,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    collector.addShared(stage, performance.now() - startedAt);
  }
}

function applyCollectedTiming(
  page: MangaPage,
  collected: Partial<Record<PageProcessingTimingStage, number>> | undefined,
  options:
    | { merge: false; translationJobId: string }
    | { merge: true; inpaintingJobId: string },
): MangaPage {
  const stages = options.merge
    ? mergeStages(page.processingTiming?.stages, collected)
    : normalizeStages(collected);
  return {
    ...page,
    processingTiming: {
      version: PAGE_PROCESSING_TIMING_VERSION,
      stages,
      measuredAt: new Date().toISOString(),
      ...(options.merge && page.processingTiming?.translationJobId
        ? { translationJobId: page.processingTiming.translationJobId }
        : {}),
      ...(options.merge
        ? { inpaintingJobId: options.inpaintingJobId }
        : { translationJobId: options.translationJobId }),
    },
  };
}

function mergeStages(
  previous: Partial<Record<PageProcessingTimingStage, number>> | undefined,
  current: Partial<Record<PageProcessingTimingStage, number>> | undefined,
): Partial<Record<PageProcessingTimingStage, number>> {
  const merged = normalizeStages(previous);
  for (const stage of PAGE_PROCESSING_TIMING_STAGES) {
    const elapsedMs = normalizeElapsedMs(current?.[stage] ?? 0);
    if (elapsedMs > 0) merged[stage] = (merged[stage] ?? 0) + elapsedMs;
  }
  return merged;
}

function normalizeStages(
  stages: Partial<Record<PageProcessingTimingStage, number>> | undefined,
): Partial<Record<PageProcessingTimingStage, number>> {
  return Object.fromEntries(
    PAGE_PROCESSING_TIMING_STAGES.flatMap((stage) => {
      const elapsedMs = normalizeElapsedMs(stages?.[stage] ?? 0);
      return elapsedMs > 0 ? [[stage, elapsedMs] as const] : [];
    }),
  );
}

function distributeIntegerMs(elapsedMs: number, count: number): number[] {
  if (count <= 0) return [];
  const total = normalizeElapsedMs(elapsedMs);
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_unused, index) =>
    index < remainder ? base + 1 : base,
  );
}

function normalizeElapsedMs(elapsedMs: number): number {
  return Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0;
}
