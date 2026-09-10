// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAsyncErrorState } from "../src/renderer/src/hooks/useAsyncErrorState";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("logs the original once but presents only localized fallback text", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { result } = renderHook(() =>
    useAsyncErrorState("다시 시도해 주세요."),
  );
  const failure = new Error("raw internal details");
  act(() => result.current.report(failure));
  expect(result.current.error).toBe("다시 시도해 주세요.");
  expect(log).toHaveBeenCalledExactlyOnceWith(failure);
  act(() => result.current.setError(""));
  expect(result.current.error).toBe("");
});
it("keeps a stable reporter with the latest locale and an explicit operation-specific message", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { result, rerender } = renderHook(
    ({ fallback }) => useAsyncErrorState(fallback),
    { initialProps: { fallback: "Retry" } },
  );
  const report = result.current.report;
  rerender({ fallback: "다시 시도" });
  expect(result.current.report).toBe(report);
  act(() => report("failure"));
  expect(result.current.error).toBe("다시 시도");
  act(() => report("save failure", "저장 실패"));
  expect(result.current.error).toBe("저장 실패");
  expect(log).toHaveBeenCalledTimes(2);
});
it("survives StrictMode setup cleanup and does not carry a closed view's late failure into a new view", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const wrapper = ({ children }: React.PropsWithChildren) => (
    <React.StrictMode>{children}</React.StrictMode>
  );
  const first = renderHook(() => useAsyncErrorState("실패"), { wrapper });
  act(() => first.result.current.report("initial"));
  expect(first.result.current.error).toBe("실패");
  const report = first.result.current.report;
  first.unmount();
  const second = renderHook(() => useAsyncErrorState("새 창"), { wrapper });
  act(() => report("late"));
  expect(second.result.current.error).toBe("");
  act(() => second.result.current.setError((current) => current + "입력 오류"));
  expect(second.result.current.error).toBe("입력 오류");
  expect(log).toHaveBeenCalledTimes(2);
});
