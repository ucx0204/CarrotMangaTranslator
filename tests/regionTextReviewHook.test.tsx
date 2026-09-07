/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRegionTextReview } from "../src/renderer/src/hooks/useRegionTextReview";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { JobEvent } from "../src/shared/jobTypes";
afterEach(cleanup);
function fixture() {
  const listeners = new Set<(event: JobEvent) => void>();
  const cancelJob = vi.fn(async () => ({ cancelled: true }));
  const confirmRegionTranslation = vi.fn(async () => true);
  window.mangaApi = createTestMangaGatewayStub({
    onJobEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancelJob,
    confirmRegionTranslation,
  });
  const hook = renderHook(() => useRegionTextReview());
  let id = "";
  act(() => {
    id = hook.result.current.begin();
  });
  const emit = (extra: Partial<JobEvent> = {}) =>
    act(() => {
      for (const listener of listeners)
        listener({
          id: "owned",
          kind: "gemma-analysis",
          status: "running",
          progressText: "working",
          regionRequestId: id,
          ...extra,
        });
    });
  const review = {
    sessionId: id,
    regions: [
      {
        id: "a",
        sourceText: "ゴ",
        translatedText: "고오",
        sourceBbox: { x: 0, y: 0, w: 100, h: 100 },
      },
    ],
  };
  return {
    ...hook,
    id,
    emit,
    review,
    cancelJob,
    confirmRegionTranslation,
    listeners,
  };
}
it("correlates the job, holds edits through submit failure and resumes exactly once", async () => {
  const h = fixture();
  h.emit({ regionRequestId: "unrelated", regionTextReview: h.review });
  expect(h.result.current.review).toBeUndefined();
  h.emit({ regionTextReview: h.review });
  expect(h.result.current.review).toEqual(h.review);
  h.confirmRegionTranslation.mockRejectedValueOnce(Error("offline"));
  await act(async () => {
    expect(
      await h.result.current.confirm([{ regionId: "a", text: "고" }]),
    ).toBe(false);
  });
  expect(h.result.current.review).toEqual(h.review);
  expect(h.result.current.error).toBe("offline");
  await act(async () => {
    expect(
      await h.result.current.confirm([{ regionId: "a", text: "고" }]),
    ).toBe(true);
  });
  expect(h.confirmRegionTranslation).toHaveBeenLastCalledWith({
    jobId: "owned",
    sessionId: h.id,
    translations: [{ regionId: "a", text: "고" }],
  });
  expect(h.listeners.size).toBe(0);
  h.unmount();
  expect(h.cancelJob).not.toHaveBeenCalled();
});
it("cancels only its own job even if the first event arrives after unmount", async () => {
  const h = fixture();
  h.unmount();
  expect(h.cancelJob).not.toHaveBeenCalled();
  h.emit({ regionRequestId: "unrelated" });
  expect(h.cancelJob).not.toHaveBeenCalled();
  h.emit();
  expect(h.cancelJob).toHaveBeenCalledExactlyOnceWith({ jobId: "owned" });
  expect(h.listeners.size).toBe(0);
});
it("handles cancel, missing job, terminal failure and a completed execution without leaking listeners", async () => {
  const h = fixture();
  await act(async () => {
    expect(await h.result.current.confirm([])).toBe(false);
  });
  h.emit({ status: "failed", detail: "failed reading" });
  expect(h.result.current.error).toBe("failed reading");
  act(() => h.result.current.finish(false));
  expect(h.result.current.busy).toBe(false);
  act(() => h.result.current.begin());
  act(() => h.result.current.finish(true));
  expect(h.listeners.size).toBe(0);
});
it("cancels once during review and never submits an already cancelled run", async () => {
  const h = fixture();
  h.emit({ regionTextReview: h.review });
  act(() => {
    h.result.current.cancel();
    h.result.current.cancel();
  });
  await act(async () => {
    expect(await h.result.current.confirm([])).toBe(false);
    h.result.current.finish(false);
  });
  expect(h.cancelJob).toHaveBeenCalledOnce();
  expect(h.result.current.review).toBeUndefined();
});

it("does not resume or close a cancelled review after an in-flight confirmation returns", async () => {
  const h = fixture();
  h.emit({ regionTextReview: h.review });
  let resolve!: (value: boolean) => void;
  h.confirmRegionTranslation.mockImplementationOnce(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  let first!: Promise<boolean>;
  act(() => {
    first = h.result.current.confirm([{ regionId: "a", text: "고" }]);
  });
  await act(async () => {
    expect(await h.result.current.confirm([])).toBe(false);
    h.result.current.cancel();
    resolve(true);
    expect(await first).toBe(false);
    h.result.current.finish(false);
  });
  expect(h.cancelJob).toHaveBeenCalledOnce();
  expect(h.result.current.review).toBeUndefined();
});
