import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTranslateRegionResult,
  resolveStartOutcome,
} from "../src/renderer/src/hooks/translationActionUtils";
import { reportRefreshLibraryFailure } from "../src/renderer/src/hooks/useTranslationActions";
import { dismissToast, getToasts } from "../src/renderer/src/lib/toastStore";

afterEach(() => {
  for (const toast of getToasts()) {
    dismissToast(toast.id);
  }
  vi.restoreAllMocks();
});

describe("translation refresh failure reporting", () => {
  it("keeps the main-process failure detail visible instead of replacing it", () => {
    const setJobState = vi.fn();
    const pushStatus = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const outcome = resolveStartOutcome(
      {
        status: "failed",
        error: "Paddle OCR GPU 실행 실패 — ROCm 초기화 오류",
      },
      setJobState,
      pushStatus,
    );

    expect(outcome).toBe("failed");
    expect(setJobState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        detail: "Paddle OCR GPU 실행 실패 — ROCm 초기화 오류",
      }),
    );
    expect(pushStatus).toHaveBeenCalledWith(
      "Paddle OCR GPU 실행 실패 — ROCm 초기화 오류",
    );
  });

  it("keeps GPU OCR failure detail visible for region translation", () => {
    const setJobState = vi.fn();
    const pushStatus = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    handleTranslateRegionResult(
      {
        status: "failed",
        error: "Paddle OCR GPU 실행 실패 — HIP 장치를 열 수 없습니다",
      },
      {
        pushStatus,
        setJobState,
        setSelectedBlockId: vi.fn(),
      },
    );

    expect(setJobState).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        detail: "Paddle OCR GPU 실행 실패 — HIP 장치를 열 수 없습니다",
      }),
    );
    expect(pushStatus).toHaveBeenCalledWith(
      "Paddle OCR GPU 실행 실패 — HIP 장치를 열 수 없습니다",
    );
  });

  it("keeps translation results but leaves status and warning toast breadcrumbs", () => {
    const statuses: string[] = [];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    reportRefreshLibraryFailure(new Error("refresh failed"), (line) => {
      statuses.push(line);
    });

    expect(consoleError).toHaveBeenCalledOnce();
    expect(statuses).toEqual(["refresh failed"]);
    expect(getToasts()).toEqual([
      expect.objectContaining({
        variant: "warn",
        message: "번역은 완료됐지만 보관함 목록 새로고침에 실패했습니다.",
      }),
    ]);
  });
});
