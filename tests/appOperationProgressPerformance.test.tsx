/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useAppOperationActivity } from "../src/renderer/src/hooks/useAppOperationActivity";
import { createAppOperationEventScheduler } from "../src/renderer/src/hooks/appOperationEventScheduler";
import type { AppOperationActivityEvent } from "../src/shared/appOperationTypes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.mangaApi = createTestMangaGatewayStub();
});

it("bounds progress notifications and commits without delaying cancellation or completion", async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  let emit!: (event: AppOperationActivityEvent) => void;
  window.mangaApi = createTestMangaGatewayStub({
    onAppOperationActivity: (listener) => {
      emit = listener;
      return () => undefined;
    },
    getActiveAppOperation: async () => null,
    getActiveAppOperations: async () => [],
  });
  const appendStatusLine = vi.fn();
  let renders = 0;
  const view = renderHook(() => {
    renders++;
    return useAppOperationActivity({ appendStatusLine });
  });
  await act(async () => undefined);
  act(() => emit(event(1)));
  const baseline = renders;
  for (let index = 2; index <= 1001; index++) act(() => emit(event(index)));
  expect(appendStatusLine).toHaveBeenCalledTimes(1);
  expect(renders - baseline).toBe(0);
  act(() => {
    for (const callback of frames.values()) callback(0);
    frames.clear();
  });
  expect(view.result.current.activity?.progressCurrent).toBe(1001);
  expect(renders - baseline).toBe(1);
  act(() => emit(event(1002, "cancelling")));
  expect(view.result.current.activity?.status).toBe("cancelling");
  act(() => emit(event(1003, "cancelled")));
  expect(view.result.current.active).toBe(false);
  act(() => emit(event(1004)));
  expect(view.result.current.activity?.status).toBe("cancelled");
  view.unmount();
  expect(frames.size).toBe(0);
});

it("does not resurrect a finished operation after a different operation starts", async () => {
  let emit!: (event: AppOperationActivityEvent) => void;
  window.mangaApi = createTestMangaGatewayStub({
    onAppOperationActivity: (listener) => {
      emit = listener;
      return () => undefined;
    },
    getActiveAppOperation: async () => null,
    getActiveAppOperations: async () => [],
  });
  const appendStatusLine = vi.fn();
  const view = renderHook(
    ({ append }) => useAppOperationActivity({ appendStatusLine: append }),
    { initialProps: { append: appendStatusLine } },
  );
  await act(async () => undefined);
  act(() => emit(event(1, "completed")));
  act(() => emit({ ...event(2), id: "other" }));
  view.rerender({ append: vi.fn() });
  await act(async () => undefined);
  act(() => emit(event(3)));
  expect(view.result.current.activities.map((item) => item.id)).toEqual([
    "other",
  ]);
});

function event(
  updatedAt: number,
  status: AppOperationActivityEvent["status"] = "running",
): AppOperationActivityEvent {
  return {
    id: "import",
    kind: "library-import",
    status,
    phase: "import-library-writing",
    mutatesLibrary: true,
    cancellable: status === "running",
    startedAt: 1,
    updatedAt,
    progressCurrent: updatedAt,
    progressTotal: 2000,
    progressUnit: "items",
  };
}

it("cancels a queued progress frame when completion arrives before paint", () => {
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation(() => undefined);
  const apply = vi.fn();
  const scheduler = createAppOperationEventScheduler(apply, new Set());
  scheduler.enqueue(event(1), true);
  scheduler.enqueue(event(2), true);
  scheduler.enqueue(event(0), true);
  scheduler.enqueue(event(3, "completed"), true);
  expect(cancel).toHaveBeenCalledWith(7);
  expect(apply.mock.calls.map(([entry]) => entry.status)).toEqual([
    "running",
    "completed",
  ]);
  scheduler.dispose();
  scheduler.enqueue({ ...event(4), id: "later" }, true);
  expect(apply).toHaveBeenCalledTimes(2);
});
