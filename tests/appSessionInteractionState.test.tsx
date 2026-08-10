/** @vitest-environment jsdom */

import React from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppSessionLifecycleEffects } from "../src/renderer/src/app/session/useAppSessionLifecycleEffects";
import { useAppSessionUiState } from "../src/renderer/src/app/session/useAppSessionUiState";

describe("unified workspace interaction state", () => {
  it("shares one aggregate-flow flag across translation and inpainting", () => {
    const { result } = renderHook(() => useAppSessionUiState());

    act(() => result.current.setJobFlowActive(true));
    expect(result.current.jobFlowActive).toBe(true);
    expect(result.current.translationFlowActive).toBe(true);

    act(() => result.current.setTranslationFlowActive(false));
    expect(result.current.jobFlowActive).toBe(false);
  });

  it("latches cancellation only for the active aggregate flow", () => {
    const { result } = renderHook(() => useAppSessionUiState());

    act(() => result.current.requestJobFlowCancellation());
    expect(result.current.jobFlowCancellationRef.current).toBe(false);

    act(() => {
      result.current.setJobFlowActive(true);
      result.current.requestJobFlowCancellation();
    });
    expect(result.current.jobFlowCancellationRef.current).toBe(true);

    act(() => result.current.setJobFlowActive(true));
    expect(result.current.jobFlowCancellationRef.current).toBe(false);
  });

  it("resets batch translation selection when the options modal closes", () => {
    const { result } = renderHook(() => useAppSessionUiState());

    expect(result.current.translateOptionsInitialScope).toBe("current-pending");

    act(() => result.current.openTranslateOptions("work-all"));
    expect(result.current.translateOptionsOpen).toBe(true);
    expect(result.current.translateOptionsInitialScope).toBe("work-all");

    act(() => result.current.closeTranslateOptions());
    expect(result.current.translateOptionsOpen).toBe(false);
    expect(result.current.translateOptionsInitialScope).toBe("current-pending");
  });

  it("keeps ordinary workspace tools and clears original peek before retouch", () => {
    const { result } = renderHook(() => useAppSessionUiState());

    act(() => result.current.selectWorkspaceTool("block"));
    expect(result.current.stageTool).toBe("block");

    act(() => {
      result.current.setPeekOriginal(true);
      result.current.selectWorkspaceTool("brush");
    });
    expect(result.current.stageTool).toBe("brush");
    expect(result.current.peekOriginal).toBe(false);
  });

  it("keeps the active and remembered retouch tool for the app session", () => {
    const first = renderHook(() => useAppSessionUiState());

    expect(first.result.current.stageTool).toBe("select");
    expect(first.result.current.lastRetouchTool).toBe("brush");

    act(() => first.result.current.selectWorkspaceTool("ellipse"));
    expect(first.result.current.stageTool).toBe("ellipse");
    expect(first.result.current.lastRetouchTool).toBe("ellipse");

    act(() => first.result.current.selectWorkspaceTool("hand"));
    expect(first.result.current.stageTool).toBe("hand");
    expect(first.result.current.lastRetouchTool).toBe("ellipse");

    act(() => first.result.current.resetChapterScopedUi());
    expect(first.result.current.stageTool).toBe("hand");
    expect(first.result.current.lastRetouchTool).toBe("ellipse");

    act(() => first.result.current.selectWorkspaceTool("rectangle"));
    expect(first.result.current.stageTool).toBe("rectangle");
    expect(first.result.current.lastRetouchTool).toBe("rectangle");

    first.unmount();
    const restarted = renderHook(() => useAppSessionUiState());
    expect(restarted.result.current.stageTool).toBe("select");
    expect(restarted.result.current.lastRetouchTool).toBe("brush");
  });

  it("uses screen fit by default and resets zoom when the fit basis changes", () => {
    const { result } = renderHook(() => useAppSessionUiState());

    expect(result.current.workspaceFitMode).toBe("contain");
    act(() => result.current.zoomInWorkspace());
    expect(result.current.workspaceZoom).toBe(1.25);

    act(() => result.current.setWorkspaceFitMode("width"));
    expect(result.current.workspaceFitMode).toBe("width");
    expect(result.current.workspaceZoom).toBe(1);
  });

  it("returns to select whenever the selected page changes", () => {
    const onPageChange = vi.fn();
    const options = {
      currentChapter: null,
      jobState: {
        id: "idle",
        kind: "gemma-analysis" as const,
        status: "idle" as const,
        progressText: "",
      },
      onJobStart: vi.fn(),
      onPageChange,
      openErrorReport: vi.fn(),
      refreshLibrary: vi.fn(),
      resetChapterScopedUi: vi.fn(),
      setRegionSelection: vi.fn(),
      translationFlowActive: false,
    };
    const { rerender } = renderHook(
      ({ pageId }: { pageId: string }) =>
        useAppSessionLifecycleEffects({
          ...options,
          selectedPageId: pageId,
        }),
      { initialProps: { pageId: "page-1" } },
    );

    expect(onPageChange).not.toHaveBeenCalled();
    rerender({ pageId: "page-2" });
    expect(onPageChange).toHaveBeenCalledOnce();
  });

  it("opens one report for each failed job transition", () => {
    const openErrorReport = vi.fn();
    const base = {
      currentChapter: null,
      onJobStart: vi.fn(),
      onPageChange: vi.fn(),
      openErrorReport,
      refreshLibrary: vi.fn(),
      resetChapterScopedUi: vi.fn(),
      selectedPageId: null,
      setRegionSelection: vi.fn(),
      translationFlowActive: false,
    };
    const { rerender } = renderHook(
      ({ id, status }: { id: string; status: "running" | "failed" }) =>
        useAppSessionLifecycleEffects({
          ...base,
          jobState: {
            id,
            kind: "gemma-analysis",
            status,
            progressText: status === "failed" ? "OCR failed" : "Running",
            detail: status === "failed" ? "engine stopped" : undefined,
          },
        }),
      { initialProps: { id: "job-1", status: "running" } },
    );

    rerender({ id: "job-1", status: "failed" });
    expect(openErrorReport).toHaveBeenCalledTimes(1);
    expect(openErrorReport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: "job-failure",
        message: "engine stopped",
      }),
    );

    rerender({ id: "job-1", status: "failed" });
    expect(openErrorReport).toHaveBeenCalledTimes(1);
    rerender({ id: "job-2", status: "running" });
    rerender({ id: "job-2", status: "failed" });
    expect(openErrorReport).toHaveBeenCalledTimes(2);
  });

  it("does not restart unrelated lifecycle effects for job progress renders", () => {
    const onJobStart = vi.fn();
    const refreshLibrary = vi.fn();
    const resetChapterScopedUi = vi.fn();
    const { rerender } = renderHook(
      ({ progressText }: { progressText: string }) =>
        useAppSessionLifecycleEffects({
          currentChapter: null,
          jobState: {
            id: "job-1",
            kind: "gemma-analysis",
            status: "running",
            progressText,
          },
          onJobStart,
          onPageChange: () => undefined,
          openErrorReport: () => undefined,
          refreshLibrary: () => {
            refreshLibrary(progressText);
          },
          resetChapterScopedUi: () => {
            resetChapterScopedUi(progressText);
          },
          selectedPageId: null,
          setRegionSelection: () => undefined,
          translationFlowActive: false,
        }),
      { initialProps: { progressText: "1%" } },
    );

    expect(refreshLibrary).toHaveBeenCalledOnce();
    expect(resetChapterScopedUi).toHaveBeenCalledOnce();
    expect(onJobStart).toHaveBeenCalledOnce();

    rerender({ progressText: "50%" });
    rerender({ progressText: "99%" });

    expect(refreshLibrary).toHaveBeenCalledOnce();
    expect(resetChapterScopedUi).toHaveBeenCalledOnce();
    expect(onJobStart).toHaveBeenCalledOnce();
  });

  it("starts the initial library refresh once in development StrictMode", () => {
    const refreshLibrary = vi.fn();
    renderHook(
      () =>
        useAppSessionLifecycleEffects({
          currentChapter: null,
          jobState: {
            id: "idle",
            kind: "gemma-analysis",
            status: "idle",
            progressText: "",
          },
          onJobStart: () => undefined,
          onPageChange: () => undefined,
          openErrorReport: () => undefined,
          refreshLibrary,
          resetChapterScopedUi: () => undefined,
          selectedPageId: null,
          setRegionSelection: () => undefined,
          translationFlowActive: false,
        }),
      { wrapper: React.StrictMode },
    );

    expect(refreshLibrary).toHaveBeenCalledOnce();
  });

  it("refreshes the library summary when the aggregate job finishes", () => {
    const refreshLibrary = vi.fn();
    const { rerender } = renderHook(
      ({ status }: { status: "running" | "completed" }) =>
        useAppSessionLifecycleEffects({
          currentChapter: null,
          jobState: {
            id: "job-1",
            kind: "gemma-analysis",
            status,
            progressText: status,
          },
          onJobStart: () => undefined,
          onPageChange: () => undefined,
          openErrorReport: () => undefined,
          refreshLibrary,
          resetChapterScopedUi: () => undefined,
          selectedPageId: null,
          setRegionSelection: () => undefined,
          translationFlowActive: false,
        }),
      { initialProps: { status: "running" } },
    );
    expect(refreshLibrary).toHaveBeenCalledOnce();

    rerender({ status: "completed" });

    expect(refreshLibrary).toHaveBeenCalledTimes(2);
  });
});
