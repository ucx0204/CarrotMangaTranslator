/** @vitest-environment jsdom */

import React from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppSessionLifecycleEffects } from "../src/renderer/src/app/session/useAppSessionLifecycleEffects";
import { useAppSessionUiState } from "../src/renderer/src/app/session/useAppSessionUiState";
import { toast } from "../src/renderer/src/lib/toastStore";

describe("unified workspace interaction state", () => {
  it("increments the editor text-tab request token for each new block", () => {
    const { result } = renderHook(() => useAppSessionUiState());

    expect(result.current.editorTextTabRequestToken).toBe(0);
    act(() => {
      result.current.requestEditorTextTab();
      result.current.requestEditorTextTab();
    });
    expect(result.current.editorTextTabRequestToken).toBe(2);
  });

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

  it("temporarily uses the hand tool and restores the previously latched tool", () => {
    const { result } = renderHook(() => useAppSessionUiState());

    act(() => result.current.selectWorkspaceTool("brush"));
    expect(result.current.stageTool).toBe("brush");
    expect(result.current.inpaintingTool).toBe("brush");

    act(() => result.current.beginTemporaryHandTool());
    expect(result.current.stageTool).toBe("hand");
    expect(result.current.inpaintingTool).toBe("none");

    act(() => result.current.endTemporaryHandTool());
    expect(result.current.stageTool).toBe("brush");
    expect(result.current.inpaintingTool).toBe("brush");
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
    expect(result.current.workspaceZoom).toBe(1.12);

    act(() => result.current.setWorkspaceFitMode("width"));
    expect(result.current.workspaceFitMode).toBe("width");
    expect(result.current.workspaceZoom).toBe(1);
  });

  it("keeps original-image opacity per page for only the current app session", () => {
    const first = renderHook(() => useAppSessionUiState());

    expect(first.result.current.originalImageOpacityByPage).toEqual({});
    act(() => {
      first.result.current.setOriginalImageOpacityForPage("page-1", 0.376);
      first.result.current.setOriginalImageOpacityForPage("page-2", 2);
    });
    expect(first.result.current.originalImageOpacityByPage).toEqual({
      "page-1": 0.38,
      "page-2": 1,
    });

    act(() => first.result.current.resetChapterScopedUi());
    expect(first.result.current.originalImageOpacityByPage["page-1"]).toBe(
      0.38,
    );
    act(() =>
      first.result.current.setOriginalImageOpacityForPage("page-1", -1),
    );
    expect(first.result.current.originalImageOpacityByPage).toEqual({
      "page-2": 1,
    });

    first.unmount();
    const restarted = renderHook(() => useAppSessionUiState());
    expect(restarted.result.current.originalImageOpacityByPage).toEqual({});
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

  it("raises one failure toast per failed job and opens the report only on request", () => {
    const openErrorReport = vi.fn();
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("toast-id");
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

    // The run status panel and status log already carry the failure, so the
    // dialog must never open on its own and steal focus.
    rerender({ id: "job-1", status: "failed" });
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(openErrorReport).not.toHaveBeenCalled();

    rerender({ id: "job-1", status: "failed" });
    expect(errorToast).toHaveBeenCalledTimes(1);
    rerender({ id: "job-2", status: "running" });
    rerender({ id: "job-2", status: "failed" });
    expect(errorToast).toHaveBeenCalledTimes(2);
    expect(openErrorReport).not.toHaveBeenCalled();

    const reportAction = errorToast.mock.calls.at(-1)?.[1]?.action;
    expect(reportAction?.label).toBe("오류 보고");
    reportAction?.onClick();
    expect(openErrorReport).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: "job-failure",
        message: "engine stopped",
      }),
      { force: true },
    );
    errorToast.mockRestore();
  });

  it("shows token-limit guidance without offering an error report", () => {
    const openErrorReport = vi.fn();
    const errorToast = vi.spyOn(toast, "error").mockReturnValue("toast-id");
    const { rerender } = renderHook(
      ({ status }: { status: "running" | "failed" }) =>
        useAppSessionLifecycleEffects({
          currentChapter: null,
          jobState: {
            id: "job-token-limit",
            kind: "gemma-analysis",
            status,
            progressText: status,
            ...(status === "failed"
              ? {
                  phase: "failed" as const,
                  failureGuidance: "increase-max-output-tokens" as const,
                }
              : {}),
          },
          onJobStart: vi.fn(),
          onPageChange: vi.fn(),
          openErrorReport,
          refreshLibrary: vi.fn(),
          resetChapterScopedUi: vi.fn(),
          selectedPageId: null,
          setRegionSelection: vi.fn(),
          translationFlowActive: false,
        }),
      {
        initialProps: {
          status: "running",
        } as { status: "running" | "failed" },
      },
    );

    rerender({ status: "failed" });

    expect(errorToast).toHaveBeenCalledWith(
      "최대 출력 토큰이 부족합니다. 설정 > LLM > 최대 출력 토큰을 늘려 주세요.",
    );
    expect(errorToast.mock.calls[0]?.[1]).toBeUndefined();
    expect(openErrorReport).not.toHaveBeenCalled();
    errorToast.mockRestore();
  });

  it("notifies a cancelled job without opening an error report", () => {
    const infoToast = vi.spyOn(toast, "info").mockReturnValue("toast-id");
    const openErrorReport = vi.fn();
    const { rerender } = renderHook(
      ({ status }: { status: "running" | "cancelled" }) =>
        useAppSessionLifecycleEffects({
          currentChapter: null,
          jobState: {
            id: "job-1",
            kind: "gemma-analysis",
            status,
            progressText: status,
          },
          onJobStart: vi.fn(),
          onPageChange: vi.fn(),
          openErrorReport,
          refreshLibrary: vi.fn(),
          resetChapterScopedUi: vi.fn(),
          selectedPageId: null,
          setRegionSelection: vi.fn(),
          translationFlowActive: false,
        }),
      { initialProps: { status: "running" } },
    );

    rerender({ status: "cancelled" });

    expect(infoToast).toHaveBeenCalledOnce();
    expect(infoToast).toHaveBeenCalledWith("작업이 취소되었습니다.");
    expect(openErrorReport).not.toHaveBeenCalled();
    infoToast.mockRestore();
  });

  it("plays the completion callback once after an aggregate job fully settles", () => {
    type CompletionLifecycleProps = {
      status: "running" | "completed";
      translationFlowActive: boolean;
    };
    const onAudibleCompletion = vi.fn();
    const successToast = vi.spyOn(toast, "success").mockReturnValue("toast-id");
    const { rerender } = renderHook(
      ({ status, translationFlowActive }: CompletionLifecycleProps) =>
        useAppSessionLifecycleEffects({
          currentChapter: null,
          jobState: {
            id: "job-completion-sound",
            kind: "gemma-analysis",
            status,
            progressText: status,
          },
          onAudibleCompletion,
          onJobStart: vi.fn(),
          onPageChange: vi.fn(),
          openErrorReport: vi.fn(),
          refreshLibrary: vi.fn(),
          resetChapterScopedUi: vi.fn(),
          selectedPageId: null,
          setRegionSelection: vi.fn(),
          translationFlowActive,
        }),
      {
        initialProps: {
          status: "running" as const,
          translationFlowActive: true,
        } as CompletionLifecycleProps,
      },
    );

    rerender({ status: "completed", translationFlowActive: true });
    expect(onAudibleCompletion).not.toHaveBeenCalled();

    rerender({ status: "completed", translationFlowActive: false });
    expect(onAudibleCompletion).toHaveBeenCalledOnce();
    expect(onAudibleCompletion).toHaveBeenCalledWith("translation");
    expect(successToast).toHaveBeenCalledOnce();

    rerender({ status: "completed", translationFlowActive: false });
    expect(onAudibleCompletion).toHaveBeenCalledOnce();
    successToast.mockRestore();
  });

  it("uses the dedicated completion sound for an SFX translation job", () => {
    const onAudibleCompletion = vi.fn();
    const successToast = vi.spyOn(toast, "success").mockReturnValue("toast-id");
    const { rerender } = renderHook(
      ({ status }: { status: "running" | "completed" }) =>
        useAppSessionLifecycleEffects({
          currentChapter: null,
          jobState: {
            id: "sound-effect-translation-completed",
            kind: "sound-effect-translation",
            status,
            progressText: "효과음 번역 완료",
          },
          onAudibleCompletion,
          onJobStart: vi.fn(),
          onPageChange: vi.fn(),
          openErrorReport: vi.fn(),
          refreshLibrary: vi.fn(),
          resetChapterScopedUi: vi.fn(),
          selectedPageId: null,
          setRegionSelection: vi.fn(),
          translationFlowActive: false,
        }),
      {
        initialProps: {
          status: "running",
        } as { status: "running" | "completed" },
      },
    );

    rerender({ status: "completed" });

    expect(onAudibleCompletion).toHaveBeenCalledOnce();
    expect(onAudibleCompletion).toHaveBeenCalledWith("sound-effect");
    expect(successToast).toHaveBeenCalledOnce();
    successToast.mockRestore();
  });

  it("plays the completion sound once when the full source-erasing flow settles", () => {
    type ErasingLifecycleProps = {
      status: "running" | "completed";
      flowActive: boolean;
    };
    const onAudibleCompletion = vi.fn();
    const successToast = vi.spyOn(toast, "success").mockReturnValue("toast-id");
    const { rerender } = renderHook(
      ({ status, flowActive }: ErasingLifecycleProps) =>
        useAppSessionLifecycleEffects({
          currentChapter: null,
          jobState: {
            id: "inpainting-flow-completed",
            kind: "inpainting",
            status,
            progressText: "원문 지우기 완료",
          },
          onAudibleCompletion,
          onJobStart: vi.fn(),
          onPageChange: vi.fn(),
          openErrorReport: vi.fn(),
          refreshLibrary: vi.fn(),
          resetChapterScopedUi: vi.fn(),
          selectedPageId: null,
          setRegionSelection: vi.fn(),
          translationFlowActive: flowActive,
        }),
      {
        initialProps: {
          status: "running" as const,
          flowActive: true,
        } as ErasingLifecycleProps,
      },
    );

    rerender({ status: "completed", flowActive: true });
    expect(onAudibleCompletion).not.toHaveBeenCalled();

    rerender({ status: "completed", flowActive: false });
    expect(onAudibleCompletion).toHaveBeenCalledOnce();
    expect(onAudibleCompletion).toHaveBeenCalledWith("source-erasing");
    expect(successToast).toHaveBeenCalledOnce();

    rerender({ status: "completed", flowActive: false });
    expect(onAudibleCompletion).toHaveBeenCalledOnce();
    successToast.mockRestore();
  });

  it("plays the internet-research completion sound once", () => {
    type ResearchLifecycleProps = { status: "running" | "completed" };
    const onAudibleCompletion = vi.fn();
    const successToast = vi.spyOn(toast, "success").mockReturnValue("toast-id");
    const { rerender } = renderHook(
      ({ status }: { status: "running" | "completed" }) =>
        useAppSessionLifecycleEffects({
          currentChapter: null,
          jobState: {
            id: "internet-research-completed",
            kind: "internet-research",
            status,
            progressText: "인터넷 조사 완료",
          },
          onAudibleCompletion,
          onJobStart: vi.fn(),
          onPageChange: vi.fn(),
          openErrorReport: vi.fn(),
          refreshLibrary: vi.fn(),
          resetChapterScopedUi: vi.fn(),
          selectedPageId: null,
          setRegionSelection: vi.fn(),
          translationFlowActive: false,
        }),
      {
        initialProps: {
          status: "running" as const,
        } as ResearchLifecycleProps,
      },
    );

    rerender({ status: "completed" });
    expect(onAudibleCompletion).toHaveBeenCalledOnce();
    expect(onAudibleCompletion).toHaveBeenCalledWith("research");
    expect(successToast).toHaveBeenCalledOnce();

    rerender({ status: "completed" });
    expect(onAudibleCompletion).toHaveBeenCalledOnce();
    successToast.mockRestore();
  });

  it.each([
    ["page export", "page-export", "page-export-1"],
    ["work-context analysis", "gemma-analysis", "work-context-1"],
  ] as const)(
    "does not request a completion sound for %s",
    (_label, kind, id) => {
      const onAudibleCompletion = vi.fn();
      const successToast = vi
        .spyOn(toast, "success")
        .mockReturnValue("toast-id");
      const initialProps: { status: "running" | "completed" } = {
        status: "running",
      };
      const { rerender } = renderHook(
        ({ status }: { status: "running" | "completed" }) =>
          useAppSessionLifecycleEffects({
            currentChapter: null,
            jobState: { id, kind, status, progressText: status },
            onAudibleCompletion,
            onJobStart: vi.fn(),
            onPageChange: vi.fn(),
            openErrorReport: vi.fn(),
            refreshLibrary: vi.fn(),
            resetChapterScopedUi: vi.fn(),
            selectedPageId: null,
            setRegionSelection: vi.fn(),
            translationFlowActive: false,
          }),
        { initialProps },
      );

      rerender({ status: "completed" });

      expect(onAudibleCompletion).not.toHaveBeenCalled();
      expect(successToast).toHaveBeenCalledOnce();
      successToast.mockRestore();
    },
  );

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
