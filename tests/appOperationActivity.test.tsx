/** @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useAppOperationActivity } from "../src/renderer/src/hooks/useAppOperationActivity";
import { toast } from "../src/renderer/src/lib/toastStore";
import type { AppOperationActivityEvent } from "../src/shared/appOperationTypes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.mangaApi = createTestMangaGatewayStub();
});

describe("useAppOperationActivity", () => {
  it("hydrates, tracks phases, cancels by id, and ignores stale events", async () => {
    let listener: (event: AppOperationActivityEvent) => void = () => undefined;
    const unsubscribe = vi.fn();
    const cancelAppOperation = vi.fn(async () => ({ accepted: true }));
    window.mangaApi = createTestMangaGatewayStub({
      cancelAppOperation,
      getActiveAppOperation: vi.fn(async () => makeActivity()),
      onAppOperationActivity: (next) => {
        listener = next;
        return unsubscribe;
      },
    });
    const appendStatusLine = vi.fn();
    const infoToast = vi.spyOn(toast, "info");
    const view = renderHook(() =>
      useAppOperationActivity({ appendStatusLine }),
    );

    await waitFor(() => expect(view.result.current.active).toBe(true));
    expect(view.result.current.libraryMutationBlocked).toBe(true);
    expect(appendStatusLine).not.toHaveBeenCalled();

    await act(async () => view.result.current.cancel());
    expect(cancelAppOperation).toHaveBeenCalledWith("import-1");

    act(() =>
      listener(
        makeActivity({
          phase: "import-finalizing",
          cancellable: false,
          updatedAt: 2,
        }),
      ),
    );
    expect(appendStatusLine).toHaveBeenLastCalledWith(
      expect.stringMatching(/보관함에 추가.*마무리/),
      undefined,
    );

    act(() =>
      listener(
        makeActivity({
          status: "completed",
          phase: "import-finalizing",
          cancellable: false,
          updatedAt: 3,
        }),
      ),
    );
    expect(view.result.current.active).toBe(false);
    expect(infoToast).not.toHaveBeenCalled();

    act(() => listener(makeActivity({ updatedAt: 2 })));
    expect(view.result.current.activity?.status).toBe("completed");
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("reports cancellation failures and clears finished operation state", async () => {
    let listener: (event: AppOperationActivityEvent) => void = () => undefined;
    const cancelAppOperation = vi.fn(async () => {
      throw new Error("cancel unavailable");
    });
    window.mangaApi = createTestMangaGatewayStub({
      cancelAppOperation,
      getActiveAppOperation: vi.fn(async () => null),
      onAppOperationActivity: (next) => {
        listener = next;
        return () => undefined;
      },
    });
    const appendStatusLine = vi.fn();
    const errorToast = vi.spyOn(toast, "error");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = renderHook(() =>
      useAppOperationActivity({ appendStatusLine }),
    );

    act(() => listener(makeActivity()));
    await act(async () => view.result.current.cancel());
    expect(appendStatusLine).toHaveBeenLastCalledWith(
      "작업 취소를 요청하지 못했습니다.",
    );
    expect(errorToast).toHaveBeenCalledWith("작업 취소를 요청하지 못했습니다.");

    act(() =>
      listener(
        makeActivity({
          status: "completed",
          cancellable: false,
          updatedAt: 2,
        }),
      ),
    );
    act(() => view.result.current.clearTerminal());
    expect(view.result.current.activity).toBeNull();
    await act(async () => view.result.current.cancel());
    expect(cancelAppOperation).toHaveBeenCalledOnce();
  });

  it("keeps subscription and hydration failures non-fatal", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    window.mangaApi = createTestMangaGatewayStub({
      getActiveAppOperation: vi.fn(async () => {
        throw new Error("hydrate unavailable");
      }),
      onAppOperationActivity: () => {
        throw new Error("subscription unavailable");
      },
    });

    const view = renderHook(() =>
      useAppOperationActivity({ appendStatusLine: vi.fn() }),
    );
    await waitFor(() => expect(warning).toHaveBeenCalledTimes(2));
    expect(view.result.current.activity).toBeNull();
  });
});

function makeActivity(
  overrides: Partial<AppOperationActivityEvent> = {},
): AppOperationActivityEvent {
  return {
    id: "import-1",
    kind: "library-import",
    status: "running",
    phase: "import-library-writing",
    sourceKind: "pdf",
    mutatesLibrary: true,
    cancellable: true,
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
