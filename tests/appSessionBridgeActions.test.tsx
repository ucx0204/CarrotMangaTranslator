/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useAppSessionBridgeActions } from "../src/renderer/src/app/session/useAppSessionBridgeActions";

afterEach(() => {
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("app session bridge actions", () => {
  it("latches aggregate cancellation before sending the main-process request", async () => {
    const calls: string[] = [];
    const cancelJob = vi.fn(async () => {
      calls.push("ipc");
      return { cancelled: false };
    });
    window.mangaApi = createTestMangaGatewayStub({ cancelJob });
    const requestFlowCancellation = vi.fn(() => calls.push("flow"));
    const { result } = renderHook(() =>
      useAppSessionBridgeActions(vi.fn(), requestFlowCancellation),
    );

    act(() => result.current.cancelJob());

    expect(requestFlowCancellation).toHaveBeenCalledOnce();
    await waitFor(() => expect(cancelJob).toHaveBeenCalledOnce());
    expect(calls).toEqual(["flow", "ipc"]);
  });
});
