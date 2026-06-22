import { afterEach, describe, expect, it, vi } from "vitest";
import { reportRefreshLibraryFailure } from "../src/renderer/src/hooks/useTranslationActions";
import { dismissToast, getToasts } from "../src/renderer/src/lib/toastStore";

afterEach(() => {
  for (const toast of getToasts()) {
    dismissToast(toast.id);
  }
  vi.restoreAllMocks();
});

describe("translation refresh failure reporting", () => {
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
