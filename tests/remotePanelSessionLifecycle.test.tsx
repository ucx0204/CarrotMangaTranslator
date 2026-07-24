/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelSyncState } from "../src/shared/panelBridgeTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useRemotePanelSession } from "../src/renderer/src/panels/useRemotePanelSession";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("remote panel session lifecycle", () => {
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
