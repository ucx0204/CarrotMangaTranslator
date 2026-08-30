import type { MangaPage } from "../../../shared/libraryTypes";
import {
  PAGE_PROCESSING_TIMING_STAGES,
  normalizePageProcessingTiming,
  type PageProcessingTimingStage,
  type PageProcessingTimingState,
} from "../../../shared/pageProcessingTiming";

type PageTimingReportRow = {
  pageId: string;
  pageName: string;
  secondsByStage: Record<PageProcessingTimingStage, number>;
  state: PageProcessingTimingState;
  totalSeconds: number;
};

export type PageTimingReport = {
  rows: PageTimingReportRow[];
  secondsByStage: Record<PageProcessingTimingStage, number>;
  totalSeconds: number;
};

type RawPageTiming = {
  pageId: string;
  pageName: string;
  millisecondsByStage: Record<PageProcessingTimingStage, number>;
  state: PageProcessingTimingState;
  totalMilliseconds: number;
};

const CENTISECOND_MS = 10;

export function buildPageTimingReport(
  pages: readonly MangaPage[],
): PageTimingReport {
  const rawRows = pages.flatMap(readRawPageTiming);
  const totalMilliseconds = sum(rawRows.map((row) => row.totalMilliseconds));
  const totalCentiseconds = Math.round(totalMilliseconds / CENTISECOND_MS);
  const pageCentiseconds = apportionIntegerTotal(
    rawRows.map((row) => row.totalMilliseconds),
    totalCentiseconds,
  );
  const rows = rawRows.map((row, index) =>
    buildReportRow(row, pageCentiseconds[index] ?? 0),
  );
  return {
    rows,
    secondsByStage: sumReportStages(rows),
    totalSeconds: toSeconds(totalCentiseconds),
  };
}

/** Deterministic largest-remainder allocation with index as the final tie-breaker. */
export function apportionIntegerTotal(
  weights: readonly number[],
  total: number,
): number[] {
  const normalizedTotal = Math.max(0, Math.round(total));
  const normalizedWeights = weights.map(normalizeMilliseconds);
  const weightTotal = sum(normalizedWeights);
  if (normalizedWeights.length === 0) return [];
  if (weightTotal <= 0 || normalizedTotal <= 0) {
    return normalizedWeights.map(() => 0);
  }
  const quotas = normalizedWeights.map(
    (weight) => (weight / weightTotal) * normalizedTotal,
  );
  const allocation = quotas.map(Math.floor);
  const remaining = normalizedTotal - sum(allocation);
  const order = quotas
    .map((quota, index) => ({
      fraction: quota - Math.floor(quota),
      index,
      weight: normalizedWeights[index],
    }))
    .sort(
      (left, right) =>
        right.fraction - left.fraction ||
        right.weight - left.weight ||
        left.index - right.index,
    );
  for (let index = 0; index < remaining; index += 1) {
    const target = order[index % order.length];
    if (target) allocation[target.index] += 1;
  }
  return allocation;
}

function readRawPageTiming(page: MangaPage): RawPageTiming[] {
  if (!page.processingTiming) return [];
  const normalized = normalizePageProcessingTiming(page.processingTiming);
  const millisecondsByStage = Object.fromEntries(
    PAGE_PROCESSING_TIMING_STAGES.map((stage) => [
      stage,
      normalizeMilliseconds(normalized.stages[stage] ?? 0),
    ]),
  ) as Record<PageProcessingTimingStage, number>;
  return [
    {
      pageId: page.id,
      pageName: page.name,
      millisecondsByStage,
      state: normalized.state,
      totalMilliseconds: sum(Object.values(millisecondsByStage)),
    },
  ];
}

function buildReportRow(
  row: RawPageTiming,
  totalCentiseconds: number,
): PageTimingReportRow {
  const allocation = apportionIntegerTotal(
    PAGE_PROCESSING_TIMING_STAGES.map(
      (stage) => row.millisecondsByStage[stage],
    ),
    totalCentiseconds,
  );
  const secondsByStage = Object.fromEntries(
    PAGE_PROCESSING_TIMING_STAGES.map((stage, index) => [
      stage,
      toSeconds(allocation[index] ?? 0),
    ]),
  ) as Record<PageProcessingTimingStage, number>;
  return {
    pageId: row.pageId,
    pageName: row.pageName,
    secondsByStage,
    state: row.state,
    totalSeconds: toSeconds(totalCentiseconds),
  };
}

function sumReportStages(
  rows: readonly PageTimingReportRow[],
): Record<PageProcessingTimingStage, number> {
  return Object.fromEntries(
    PAGE_PROCESSING_TIMING_STAGES.map((stage) => [
      stage,
      roundCentiseconds(sum(rows.map((row) => row.secondsByStage[stage]))),
    ]),
  ) as Record<PageProcessingTimingStage, number>;
}

function toSeconds(centiseconds: number): number {
  return Math.max(0, Math.round(centiseconds)) / 100;
}

function roundCentiseconds(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}

function normalizeMilliseconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
