/* eslint-disable max-lines-per-function -- collector state and checkpoint snapshots must share one closure */
import { performance } from "node:perf_hooks";
import type { MangaPage } from "../../shared/libraryTypes";
import {
  PAGE_PROCESSING_TIMING_STAGES,
  PAGE_PROCESSING_TIMING_VERSION,
  normalizePageProcessingTiming,
  sumPageProcessingTimingStages,
  type PageProcessingTimingState,
  type PageProcessingTimingStage,
  type PageProcessingTimingV2,
} from "../../shared/pageProcessingTiming";

export type PageTimingCheckpoint = Readonly<{
  pageId: string;
  timing: PageProcessingTimingV2;
}>;

type PageProcessingTimingCollectorOptions = {
  sessionId?: string;
  managed?: boolean;
  state?: PageProcessingTimingState;
  initialStagesByPageId?: ReadonlyMap<
    string,
    Partial<Record<PageProcessingTimingStage, number>>
  >;
  initialCheckpoint?: number;
  translationJobId?: string;
  inpaintingJobId?: string;
  onBeforeCheckpoint?: () => void;
  onCheckpoint?: (updates: readonly PageTimingCheckpoint[]) => Promise<void>;
};

export type PageProcessingTimingCollector = ReturnType<
  typeof createPageProcessingTimingCollector
>;

export function createPageProcessingTimingCollector(
  jobId: string,
  pageIds: readonly string[],
  options: PageProcessingTimingCollectorOptions = {},
) {
  const uniquePageIds = [...new Set(pageIds)];
  const stagesByPageId = new Map<
    string,
    Partial<Record<PageProcessingTimingStage, number>>
  >(
    uniquePageIds.map((pageId) => [
      pageId,
      normalizeStages(options.initialStagesByPageId?.get(pageId)),
    ]),
  );
  let state = options.state ?? (options.managed ? "running" : "completed");
  let checkpointNumber = normalizeCheckpoint(options.initialCheckpoint);
  let translationJobId = options.translationJobId;
  let inpaintingJobId = options.inpaintingJobId;

  const add = (
    pageId: string,
    stage: PageProcessingTimingStage,
    elapsedMs: number,
  ): void => {
    if (!stagesByPageId.has(pageId)) return;
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

  const setStage = (
    pageId: string,
    stage: PageProcessingTimingStage,
    elapsedMs: number,
  ): void => {
    if (!stagesByPageId.has(pageId)) return;
    const stages = stagesByPageId.get(pageId) ?? {};
    const normalized = normalizeElapsedMs(elapsedMs);
    if (normalized > 0) stages[stage] = normalized;
    else delete stages[stage];
    stagesByPageId.set(pageId, stages);
  };

  const buildTiming = (pageId: string): PageProcessingTimingV2 => ({
    version: PAGE_PROCESSING_TIMING_VERSION,
    stages: normalizeStages(stagesByPageId.get(pageId)),
    measuredAt: new Date().toISOString(),
    sessionId: options.sessionId ?? jobId,
    state,
    checkpoint: checkpointNumber,
    ...(translationJobId ? { translationJobId } : {}),
    ...(inpaintingJobId ? { inpaintingJobId } : {}),
  });

  const checkpoint = async (): Promise<void> => {
    options.onBeforeCheckpoint?.();
    if (!options.onCheckpoint) return;
    checkpointNumber += 1;
    const updates = uniquePageIds.map((pageId) => ({
      pageId,
      timing: buildTiming(pageId),
    }));
    await options.onCheckpoint(updates);
  };

  const applyManagedTiming = (page: MangaPage): MangaPage => ({
    ...page,
    processingTiming: buildTiming(page.id),
  });

  return {
    add,
    addShared,
    setStage,
    checkpoint,
    getPageIds: (): readonly string[] => uniquePageIds,
    getStages: (
      pageId: string,
    ): Partial<Record<PageProcessingTimingStage, number>> =>
      normalizeStages(stagesByPageId.get(pageId)),
    getTotalMilliseconds: (): number =>
      [...stagesByPageId.values()].reduce(
        (total, stages) => total + sumPageProcessingTimingStages(stages),
        0,
      ),
    setState: (nextState: PageProcessingTimingState): void => {
      state = nextState;
    },
    setTranslationJobId: (nextJobId: string): void => {
      translationJobId = nextJobId;
    },
    setInpaintingJobId: (nextJobId: string): void => {
      inpaintingJobId = nextJobId;
    },
    applyInpaintingTiming: (page: MangaPage): MangaPage => {
      if (options.managed) return applyManagedTiming(page);
      return applyStandaloneTiming(page, stagesByPageId.get(page.id), {
        sessionId: options.sessionId ?? jobId,
        inpaintingJobId: jobId,
        merge: true,
      });
    },
    applyTranslationTiming: (page: MangaPage): MangaPage => {
      if (options.managed) return applyManagedTiming(page);
      return applyStandaloneTiming(page, stagesByPageId.get(page.id), {
        sessionId: options.sessionId ?? jobId,
        translationJobId: jobId,
        merge: false,
      });
    },
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
    await collector.checkpoint();
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
    await collector.checkpoint();
  }
}

function applyStandaloneTiming(
  page: MangaPage,
  collected: Partial<Record<PageProcessingTimingStage, number>> | undefined,
  options:
    | { merge: false; translationJobId: string; sessionId: string }
    | { merge: true; inpaintingJobId: string; sessionId: string },
): MangaPage {
  const previous = normalizePageProcessingTiming(page.processingTiming).stages;
  const stages = options.merge
    ? mergeStages(previous, collected)
    : normalizeStages(collected);
  return {
    ...page,
    processingTiming: {
      version: PAGE_PROCESSING_TIMING_VERSION,
      stages,
      measuredAt: new Date().toISOString(),
      sessionId: options.sessionId,
      state: "completed",
      checkpoint: 0,
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

function normalizeCheckpoint(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;
}
