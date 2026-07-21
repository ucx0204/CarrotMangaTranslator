import { describe, expect, it } from "vitest";

const { createOcrBatchProgress } =
  require("../src/main/runtime/ocr/bbox-batch-progress.cjs") as {
    createOcrBatchProgress: (dependencies: {
      readPositiveInteger: (value: unknown) => number | null;
      emitRuntimeProgress: (
        options: object | undefined,
        phase: string,
        progressText: string,
        detail?: string,
        progress?: Record<string, unknown>,
      ) => void;
      parseOcrBatchProgressLine: () => null;
    }) => {
      createOcrBatchProgressEmitter: (
        batchOptions: Record<string, unknown>,
        firstOptions: Record<string, unknown>,
        normalizedOptions: Array<Record<string, unknown>>,
      ) => (progress: {
        itemIndex: number;
        phase: string;
        count: number;
      }) => void;
    };
  };

describe("OCR batch progress", () => {
  it("does not count a failed page as completed and reports fail-fast semantics", () => {
    const events: Array<{
      phase: string;
      progressText: string;
      detail?: string;
      progress?: Record<string, unknown>;
    }> = [];
    const progress = createOcrBatchProgress({
      readPositiveInteger: (value) => {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      },
      emitRuntimeProgress: (
        _options,
        phase,
        progressText,
        detail,
        progressValues,
      ) => {
        events.push({
          phase,
          progressText,
          detail,
          progress: progressValues,
        });
      },
      parseOcrBatchProgressLine: () => null,
    }).createOcrBatchProgressEmitter(
      {},
      {
        ocrBatchCompletedBefore: 2,
        ocrBatchTotal: 5,
        ocrPageTotal: 5,
      },
      [{}, {}, {}],
    );

    progress({ itemIndex: 0, phase: "done", count: 4 });
    progress({ itemIndex: 1, phase: "start", count: 0 });
    progress({ itemIndex: 1, phase: "error", count: 0 });

    expect(events[0]).toMatchObject({
      progressText: "3 / 5 페이지 Paddle OCR 분석 중",
      detail: "4개 후보",
      progress: {
        progressCurrent: 3,
        progressTotal: 5,
        pageIndex: 3,
        pageTotal: 5,
      },
    });
    expect(events[2]).toEqual({
      phase: "ocr_running",
      progressText: "4 / 5 페이지 OCR 실패",
      detail: "OCR 오류가 발생하여 작업을 중단합니다",
      progress: {
        progressCurrent: 3,
        progressTotal: 5,
        pageIndex: 4,
        pageTotal: 5,
      },
    });
  });
});
