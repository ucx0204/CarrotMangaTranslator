import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { formatElapsedDuration } from "../src/renderer/src/lib/appHelpers";
import {
  formatBytes,
  formatJobEventLine,
  formatJobLabel,
  resolveProgressSnapshot,
  summarizeWarnings,
} from "../src/renderer/src/lib/jobProgress";

const testTranslator = ((key: string) =>
  `translated:${key}`) as TFunction<"renderer">;

describe("job progress helpers", () => {
  it("formats structured page progress into short Korean labels", () => {
    expect(
      formatJobEventLine({
        id: "job-1",
        kind: "gemma-analysis",
        status: "running",
        progressText: "raw",
        phase: "page_running",
        pageIndex: 3,
        pageTotal: 20,
        progressCurrent: 3,
        progressTotal: 20,
      }),
    ).toBe("3 / 20 페이지 번역 중");

    expect(
      formatJobLabel({
        status: "running",
        phase: "page_retry",
        pageIndex: 3,
        pageTotal: 20,
        attempt: 2,
        attemptTotal: 5,
      }),
    ).toBe("3 / 20 페이지 재시도 2 / 5");

    expect(
      formatJobLabel({
        status: "running",
        phase: "ocr_running",
        pageIndex: 3,
        pageTotal: 20,
      }),
    ).toBe("3 / 20 페이지 Paddle OCR 분석 중");

    expect(
      formatJobLabel({
        status: "running",
        phase: "ocr_running",
        progressText: "Paddle OCR 선분석 완료",
      }),
    ).toBe("Paddle OCR 선분석 완료");

    expect(
      formatJobLabel({
        status: "running",
        phase: "model_requesting",
        pageIndex: 3,
        pageTotal: 20,
      }),
    ).toBe("3 / 20 페이지 AI 번역 요청 중");
  });

  it("keeps elapsed time out of work-center status records", () => {
    expect(
      formatJobEventLine({
        id: "job-1",
        kind: "gemma-analysis",
        status: "running",
        progressText: "raw",
        phase: "page_done",
        pageIndex: 3,
        pageTotal: 20,
        pageElapsedMs: 83_400,
      }),
    ).toBe("3 / 20 페이지 완료");

    expect(
      formatJobEventLine({
        id: "job-1",
        kind: "gemma-analysis",
        status: "completed",
        progressText: "번역 완료",
        phase: "done",
        jobElapsedMs: 3_723_400,
      }),
    ).toBe("번역 완료");
    expect(formatElapsedDuration(420)).toBe("1초 미만");
    expect(formatElapsedDuration(45_200)).toBe("45초");
    expect(formatElapsedDuration(-1)).toBeNull();
    expect(formatElapsedDuration(Number.NaN)).toBeNull();

    expect(
      formatJobEventLine({
        id: "job-2",
        kind: "gemma-analysis",
        status: "running",
        progressText: "raw",
        phase: "page_done",
        pageIndex: 1,
        pageTotal: 1,
      }),
    ).toBe("1 / 1 페이지 완료");
  });

  it("returns a clamped determinate progress snapshot", () => {
    expect(
      resolveProgressSnapshot({
        status: "running",
        progressCurrent: 21,
        progressTotal: 20,
      }),
    ).toEqual({
      mode: "determinate",
      current: 20,
      total: 20,
      ratio: 1,
    });

    expect(
      resolveProgressSnapshot({
        status: "running",
        progressMode: "determinate",
        progressPercent: 0.42,
      }),
    ).toEqual({
      mode: "determinate",
      current: 42,
      total: 100,
      ratio: 0.42,
    });
  });

  it("uses an indeterminate snapshot while the model is booting or downloading", () => {
    expect(
      formatJobLabel({
        status: "starting",
        phase: "booting",
        progressText: "Gemma 4 서버 시작 중",
      }),
    ).toBe("Gemma 4 서버 시작 중");
    expect(
      formatJobLabel({
        status: "starting",
        phase: "model_downloading",
        progressText: "모델 파일 다운로드 중",
      }),
    ).toBe("모델 파일 다운로드 중");

    expect(
      resolveProgressSnapshot({ status: "starting", phase: "booting" }),
    ).toEqual({
      mode: "indeterminate",
    });

    expect(
      resolveProgressSnapshot({
        status: "starting",
        phase: "model_downloading",
      }),
    ).toEqual({
      mode: "indeterminate",
    });
  });

  it("keeps explicit log-only install progress out of fake percent mode", () => {
    expect(
      resolveProgressSnapshot({
        status: "running",
        phase: "ocr_downloading",
        progressMode: "log-only",
        progressPercent: 0.5,
      }),
    ).toEqual({
      mode: "log-only",
    });
  });

  it("keeps the finalizing label unchanged", () => {
    expect(formatJobLabel({ status: "running", phase: "finalizing" })).toBe(
      "결과 정리 중",
    );
  });

  it("labels a partial terminal job without calling it completed", () => {
    expect(formatJobLabel({ status: "partial", phase: "partial" })).toBe(
      "작업 부분 완료",
    );
  });

  it("shows the exact settings field for token budget failures", () => {
    expect(
      formatJobLabel({
        status: "failed",
        phase: "failed",
        failureGuidance: "increase-max-output-tokens",
      }),
    ).toBe(
      "최대 출력 토큰이 부족합니다. 설정 > 번역 엔진 > 최대 출력 토큰을 늘려 주세요.",
    );
    expect(
      formatJobLabel({
        status: "failed",
        phase: "failed",
        failureGuidance: "increase-work-context-budget",
      }),
    ).toContain("작품 컨텍스트 예산");
    expect(
      formatJobLabel({
        status: "failed",
        phase: "failed",
        failureGuidance: "increase-context-length",
      }),
    ).toContain("VRAM");
  });

  it("preserves detailed event text while allowing locale refreshes to discard it", () => {
    const job = {
      status: "running" as const,
      phase: "finalizing" as const,
      progressText: "Exporting page 2 / 4",
    };

    expect(
      formatJobEventLine(
        { id: "job-1", kind: "inpainting", ...job },
        testTranslator,
      ),
    ).toBe("Exporting page 2 / 4");
    expect(
      formatJobLabel(job, testTranslator, {
        preserveUnknownProgressText: false,
      }),
    ).toBe("translated:job.phase.finalizing");
  });

  it("summarizes warnings into a short user-facing sentence", () => {
    expect(
      summarizeWarnings([
        "001.png: 5회 재시도 후 실패하여 이 페이지는 건너뜁니다. 마지막 오류: timeout",
        "002.png: 불확실한 OCR 조각이 2개 있습니다.",
      ]),
    ).toBe("일부 페이지를 건너뛰었고 OCR 확인이 필요한 블록도 있습니다.");

    expect(summarizeWarnings([])).toBeNull();
    expect(summarizeWarnings(["page_skipped: 001.png"])).toContain("건너뛰고");
    expect(summarizeWarnings(["uncertain_ocr: 002.png"])).toContain("OCR 확인");
    expect(summarizeWarnings(["generic warning"])).toContain("작업은 계속");
  });

  it("formats byte progress across invalid, small, and scaled values", () => {
    expect(formatBytes(Number.NaN)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.00 KB");
    expect(formatBytes(12 * 1024)).toBe("12.0 KB");
    expect(formatBytes(128 * 1024)).toBe("128 KB");
    expect(formatBytes(1.5 * 1024 ** 3, "en-US")).toBe("1.50 GB");
  });

  it("honors explicit indeterminate and empty determinate progress", () => {
    expect(
      resolveProgressSnapshot({
        status: "running",
        progressMode: "indeterminate",
      }),
    ).toEqual({ mode: "indeterminate" });
    expect(
      resolveProgressSnapshot({
        status: "running",
        progressMode: "determinate",
      }),
    ).toBeNull();
    expect(
      resolveProgressSnapshot({
        status: "running",
        progressPercent: -0.5,
      }),
    ).toEqual({ mode: "determinate", current: 0, total: 100, ratio: 0 });
  });
});
