/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppSessionLifecycleEffects } from "../src/renderer/src/app/session/useAppSessionLifecycleEffects";
import { useAppSessionUiState } from "../src/renderer/src/app/session/useAppSessionUiState";

describe("unified workspace interaction state", () => {
  it("keeps non-retouch tools when toggling the auto panel and clears peek before retouch", () => {
    const { result } = renderHook(() => useAppSessionUiState());

    act(() => result.current.selectWorkspaceTool("block"));
    act(() => result.current.toggleAutoInpainting());
    expect(result.current.stageTool).toBe("block");
    expect(result.current.autoInpaintingOpen).toBe(true);

    act(() => result.current.toggleAutoInpainting());
    expect(result.current.stageTool).toBe("block");
    expect(result.current.autoInpaintingOpen).toBe(false);

    act(() => {
      result.current.setAutoInpaintingOpen(true);
      result.current.setPeekOriginal(true);
      result.current.selectWorkspaceTool("brush");
    });
    expect(result.current.stageTool).toBe("brush");
    expect(result.current.autoInpaintingOpen).toBe(false);
    expect(result.current.peekOriginal).toBe(false);
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
      openLogFolder: vi.fn(),
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
});
