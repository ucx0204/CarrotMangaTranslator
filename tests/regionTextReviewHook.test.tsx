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
  act(() => h.result.current.finish(h.id, false));
  expect(h.result.current.busy).toBe(false);
  let nextId = "";
  act(() => {
    nextId = h.result.current.begin();
  });
  act(() => h.result.current.finish(nextId, true));
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
    h.result.current.finish(h.id, false);
  });
  expect(h.cancelJob).toHaveBeenCalledOnce();
  expect(h.result.current.review).toBeUndefined();
});

it("clears the cancelled review immediately, before the job promise settles", () => {
  const h = fixture();
  h.emit({ regionTextReview: h.review });
  act(() => h.result.current.cancel());
  expect(h.result.current.review).toBeUndefined();
  expect(h.result.current.error).toBeUndefined();
  expect(h.result.current.busy).toBe(false);
});

it("reports cancellation delivery failure without reviving or resubmitting the review", async () => {
  const h = fixture();
  const failure = new Error("cancellation channel closed");
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    h.emit({ regionTextReview: h.review });
    h.cancelJob.mockRejectedValueOnce(failure);
    await act(async () => {
      h.result.current.cancel();
    });
    expect(report).toHaveBeenCalledExactlyOnceWith(
      "Region translation cancellation failed",
      failure,
    );
    expect(h.result.current.review).toBeUndefined();
    expect(h.result.current.error).toBeUndefined();
    expect(h.result.current.busy).toBe(false);
    expect(h.listeners.size).toBe(0);
    await act(async () => {
      h.result.current.cancel();
      expect(await h.result.current.confirm([])).toBe(false);
    });
    expect(h.cancelJob).toHaveBeenCalledExactlyOnceWith({ jobId: "owned" });
    expect(h.confirmRegionTranslation).not.toHaveBeenCalled();
  } finally {
    h.unmount();
    report.mockRestore();
  }
});

it("retains edits and permits retry after a non-Error confirmation rejection", async () => {
  const h = fixture();
  h.emit({ regionTextReview: h.review });
  h.confirmRegionTranslation.mockRejectedValueOnce("connection unavailable");
  const onConfirmed = vi.fn();
  await act(async () => {
    expect(
      await h.result.current.confirm(
        [{ regionId: "a", text: "edited" }],
        onConfirmed,
      ),
    ).toBe(false);
  });
  expect(h.result.current.review).toEqual(h.review);
  expect(h.result.current.error).toBe("connection unavailable");
  expect(h.result.current.busy).toBe(false);
  expect(onConfirmed).not.toHaveBeenCalled();
  await act(async () => {
    expect(
      await h.result.current.confirm(
        [{ regionId: "a", text: "edited" }],
        onConfirmed,
      ),
    ).toBe(true);
  });
  expect(onConfirmed).toHaveBeenCalledOnce();
  expect(h.result.current.review).toBeUndefined();
  expect(h.result.current.error).toBeUndefined();
  expect(h.listeners.size).toBe(0);
});

it("does not finish a new session when the cancelled job settles late", () => {
  const h = fixture();
  h.emit({ regionTextReview: h.review });
  let nextId = "";
  act(() => {
    nextId = h.result.current.begin();
  });
  const nextReview = { ...h.review, sessionId: nextId };
  h.emit({
    id: "next-job",
    regionRequestId: nextId,
    regionTextReview: nextReview,
  });
  act(() => h.result.current.finish(h.id, true));
  expect(h.result.current.review).toEqual(nextReview);
  expect(h.listeners.size).toBe(1);
  act(() => h.result.current.finish(nextId, true));
  expect(h.result.current.review).toBeUndefined();
  expect(h.listeners.size).toBe(0);
});

it("ignores an old confirmation rejection after a new review has started", async () => {
  const h = fixture();
  h.emit({ regionTextReview: h.review });
  let reject!: (reason: Error) => void;
  h.confirmRegionTranslation.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  let pending!: Promise<boolean>;
  act(() => {
    pending = h.result.current.confirm([{ regionId: "a", text: "confirmed" }]);
  });
  let nextId = "";
  act(() => {
    nextId = h.result.current.begin();
  });
  const nextReview = { ...h.review, sessionId: nextId };
  h.emit({
    id: "next-job",
    regionRequestId: nextId,
    regionTextReview: nextReview,
  });
  await act(async () => {
    reject(new Error("old submission failed"));
    expect(await pending).toBe(false);
  });
  expect(h.result.current.review).toEqual(nextReview);
  expect(h.result.current.error).toBeUndefined();
  expect(h.result.current.busy).toBe(false);
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
    h.result.current.finish(h.id, false);
  });
  expect(h.cancelJob).toHaveBeenCalledOnce();
  expect(h.result.current.review).toBeUndefined();
});

it("forwards corrected geometry and exact exclusion mask with the owned confirmation", async () => {
  const h = fixture();
  h.emit({ regionTextReview: h.review });
  const rows = [
    {
      regionId: "a",
      text: "confirmed",
      sourceBbox: { x: 10, y: 20, w: 600, h: 450 },
    },
  ];
  const protection = {
    maskDataUrl: "data:image/png;base64,AA==",
    strokes: [
      {
        space: "page" as const,
        mode: "hide" as const,
        shape: "square" as const,
        softness: 0,
        radiusX: 20,
        radiusY: 30,
        points: [{ x: 100, y: 200 }],
      },
    ],
  };
  await act(async () => {
    expect(await h.result.current.confirm(rows, undefined, protection)).toBe(
      true,
    );
  });
  expect(h.confirmRegionTranslation).toHaveBeenCalledExactlyOnceWith({
    jobId: "owned",
    sessionId: h.id,
    translations: rows,
    protection,
  });
  h.unmount();
});
