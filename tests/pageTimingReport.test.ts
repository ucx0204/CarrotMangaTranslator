import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import {
  PAGE_PROCESSING_TIMING_VERSION,
  type PageProcessingTimingV2,
} from "../src/shared/pageProcessingTiming";
import {
  apportionIntegerTotal,
  buildPageTimingReport,
} from "../src/renderer/src/lib/pageTimingReport";

describe("page timing report", () => {
  it("preserves every nested total at 0.01-second granularity", () => {
    const report = buildPageTimingReport([
      page("page-a", "001.jpg", {
        preparing: 1_510,
        ocr: 2_499,
        translation: 10_620,
        typography: 780,
      }),
      page("page-b", "002.jpg", {
        preparing: 1_510,
        ocr: 2_501,
        translation: 9_390,
        inpainting: 5_450,
        typography: 1_160,
      }),
    ]);

    expect(report.totalSeconds).toBe(35.42);
    for (const row of report.rows) {
      expect(roundHundredths(sum(Object.values(row.secondsByStage)))).toBe(
        row.totalSeconds,
      );
    }
    expect(sum(report.rows.map((row) => row.totalSeconds))).toBe(
      report.totalSeconds,
    );
    expect(roundHundredths(sum(Object.values(report.secondsByStage)))).toBe(
      report.totalSeconds,
    );
  });

  it("uses stable largest-remainder allocation instead of changing one tail value", () => {
    expect(apportionIntegerTotal([1, 1, 1], 2)).toEqual([1, 1, 0]);
    expect(apportionIntegerTotal([500, 1_500], 3)).toEqual([1, 2]);
    expect(apportionIntegerTotal([0, Number.NaN, -2], 4)).toEqual([0, 0, 0]);
  });

  it("omits pages without a measured timing record", () => {
    const measured = page("measured", "001.jpg", { translation: 1_200 });
    const unmeasured = {
      ...page("plain", "002.jpg", {}),
      processingTiming: undefined,
    };
    const report = buildPageTimingReport([measured, unmeasured]);

    expect(report.rows.map((row) => row.pageId)).toEqual(["measured"]);
    expect(report.totalSeconds).toBe(1.2);
  });

  it("reads v1 records by merging result processing and bubble layout", () => {
    const legacy: MangaPage = {
      ...page("legacy", "legacy.jpg", {}),
      processingTiming: {
        version: 1,
        measuredAt: "2026-01-01T00:00:00.000Z",
        stages: {
          translation: 1_000,
          postprocessing: 500,
          typography: 250,
          bubbleLayout: 500,
        },
      },
    };

    const report = buildPageTimingReport([legacy]);

    expect(report.rows[0]?.secondsByStage.translation).toBe(1.5);
    expect(report.rows[0]?.secondsByStage.typography).toBe(0.75);
    expect(report.rows[0]?.state).toBe("completed");
  });
});

function page(
  id: string,
  name: string,
  stages: PageProcessingTimingV2["stages"],
): MangaPage {
  return {
    id,
    name,
    imagePath: `C:/images/${name}`,
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    processingTiming: {
      version: PAGE_PROCESSING_TIMING_VERSION,
      stages,
      measuredAt: "2026-01-01T00:00:00.000Z",
      sessionId: "00000000-0000-4000-8000-000000000001",
      state: "completed",
      checkpoint: 1,
    },
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}
