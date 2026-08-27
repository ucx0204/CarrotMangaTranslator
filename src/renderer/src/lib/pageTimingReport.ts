import type { MangaPage } from "../../../shared/libraryTypes";
import {
  PAGE_PROCESSING_TIMING_STAGES,
  PAGE_PROCESSING_TIMING_VERSION,
  type PageProcessingTimingStage,
} from "../../../shared/pageProcessingTiming";

type PageTimingReportRow = {
  pageId: string;
  pageName: string;
  secondsByStage: Record<PageProcessingTimingStage, number>;
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
  totalMilliseconds: number;
};

export function buildPageTimingReport(
  pages: readonly MangaPage[],
): PageTimingReport {
  const rawRows = pages.flatMap(readRawPageTiming);
  const totalMilliseconds = sum(rawRows.map((row) => row.totalMilliseconds));
  const totalSeconds = Math.round(totalMilliseconds / 1000);
  const pageSeconds = apportionIntegerTotal(
    rawRows.map((row) => row.totalMilliseconds),
    totalSeconds,
  );
  const rows = rawRows.map((row, index) =>
    buildReportRow(row, pageSeconds[index] ?? 0),
  );
  return {
    rows,
    secondsByStage: sumReportStages(rows),
    totalSeconds,
  };
}

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
  const timing = page.processingTiming;
  if (!timing || timing.version !== PAGE_PROCESSING_TIMING_VERSION) return [];
  const millisecondsByStage = Object.fromEntries(
    PAGE_PROCESSING_TIMING_STAGES.map((stage) => [
      stage,
      normalizeMilliseconds(timing.stages[stage] ?? 0),
    ]),
  ) as Record<PageProcessingTimingStage, number>;
  const totalMilliseconds = sum(Object.values(millisecondsByStage));
  if (totalMilliseconds <= 0) return [];
  return [
    {
      pageId: page.id,
      pageName: page.name,
      millisecondsByStage,
      totalMilliseconds,
    },
  ];
}

function buildReportRow(
  row: RawPageTiming,
  totalSeconds: number,
): PageTimingReportRow {
  const allocation = apportionIntegerTotal(
    PAGE_PROCESSING_TIMING_STAGES.map(
      (stage) => row.millisecondsByStage[stage],
    ),
    totalSeconds,
  );
  const secondsByStage = Object.fromEntries(
    PAGE_PROCESSING_TIMING_STAGES.map((stage, index) => [
      stage,
      allocation[index] ?? 0,
    ]),
  ) as Record<PageProcessingTimingStage, number>;
  return {
    pageId: row.pageId,
    pageName: row.pageName,
    secondsByStage,
    totalSeconds,
  };
}

function sumReportStages(
  rows: readonly PageTimingReportRow[],
): Record<PageProcessingTimingStage, number> {
  return Object.fromEntries(
    PAGE_PROCESSING_TIMING_STAGES.map((stage) => [
      stage,
      sum(rows.map((row) => row.secondsByStage[stage])),
    ]),
  ) as Record<PageProcessingTimingStage, number>;
}

function normalizeMilliseconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
