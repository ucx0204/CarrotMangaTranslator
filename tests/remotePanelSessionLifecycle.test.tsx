/** @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelSyncState } from "../src/shared/panelBridgeTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useRemotePanelSession } from "../src/renderer/src/panels/useRemotePanelSession";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("remote panel session lifecycle", () => {
  it("relays a consistent-edit suggestion to the main window", async () => {
    const sendPanelCommand = vi.fn(async () => ({ sent: true }));
    window.mangaApi = createTestMangaGatewayStub({
      getPanelState: async () => REMOTE_PANEL_STATE,
      onPanelState: () => () => undefined,
      sendPanelCommand,
    });

    const view = renderHook(() => useRemotePanelSession());
    await waitFor(() => expect(view.result.current).not.toBeNull());
    view.result.current?.onSuggestConsistentEdit?.("카렌", "카랜");

    await waitFor(() =>
      expect(sendPanelCommand).toHaveBeenCalledWith({
        type: "suggestConsistentEdit",
        find: "카렌",
        replace: "카랜",
      }),
    );
  });

  it("unsubscribes and ignores a late initial-state failure after unmount", async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    const request = new Promise<PanelSyncState | null>((_resolve, reject) => {
      rejectRequest = reject;
    });
    const unsubscribe = vi.fn();
    window.mangaApi = createTestMangaGatewayStub({
      getPanelState: () => request,
      onPanelState: () => unsubscribe,
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const view = renderHook(() => useRemotePanelSession());
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();

    const lateFailure = new Error("late panel state failure");
    const observedRejection = expect(request).rejects.toBe(lateFailure);
    await act(async () => {
      rejectRequest?.(lateFailure);
      await observedRejection;
    });
    expect(consoleError).not.toHaveBeenCalled();
  });
});

const REMOTE_PANEL_STATE: PanelSyncState = {
  areaTranslateAvailable: true,
  areaTranslateSelecting: false,
  blockStylePresets: [],
  disableChapterApply: false,
  editorTextTabRequestToken: 0,
  editorDisabled: false,
  formatSelection: { common: {}, mixedFields: [] },
  selectionKey: "[]",
  selectedBlock: null,
  selectedBlockCount: 0,
  selectedPageSize: { width: 1000, height: 1600 },
  transformMode: "select",
};
