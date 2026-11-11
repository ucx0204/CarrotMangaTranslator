// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppActivityState } from "../src/shared/appActivityTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import {
  usePageEditHandoff,
  usePageInputActivity,
} from "../src/renderer/src/hooks/usePageEditHandoff";
import { pendingPageEdits } from "../src/renderer/src/lib/pageEditBarrier";

const acknowledge = vi.fn(async () => true);
const idle: AppActivityState = { version: 1, activities: [], pages: [] };
const handingOff: AppActivityState = {
  version: 2,
  activities: [],
  pages: [
    {
      jobId: "job",
      chapterId: "chapter",
      pageId: "B",
      phase: "finishing-edits",
      requestId: "handoff",
    },
  ],
};
beforeEach(() => {
  acknowledge.mockClear();
  window.mangaApi = createTestMangaGatewayStub({
    finishPageEditHandoff: acknowledge,
  });
});
afterEach(cleanup);

it("reports only slow frames with the three longest scripts and disconnects on unmount", () => {
  let report!: (entries: unknown[]) => void;
  const observe = vi.fn();
  const disconnect = vi.fn();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      static supportedEntryTypes = ["long-animation-frame"];
      constructor(callback: PerformanceObserverCallback) {
        report = (entries) =>
          callback(
            { getEntries: () => entries } as PerformanceObserverEntryList,
            this,
          );
      }
      observe = observe;
      disconnect = disconnect;
      takeRecords = () => [];
    },
  );
  try {
    const { unmount } = renderHook(() => usePageEditHandoff(idle, vi.fn()));
    expect(observe).toHaveBeenCalledWith({
      type: "long-animation-frame",
      buffered: true,
    });
    report([
      { duration: 249, startTime: 0 },
      {
        duration: 501.2,
        startTime: 100,
        blockingDuration: 300.7,
        scripts: [10, 80, 40, 60].map((duration) => ({
          duration,
          invoker: "event-listener",
          sourceURL: "app.js",
          sourceFunctionName: `work${duration}`,
          forcedStyleAndLayoutDuration: 1.7,
        })),
      },
      { duration: 250, startTime: 200 },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toBe("Slow renderer frame");
    expect(JSON.parse(warn.mock.calls[0][1])).toMatchObject({
      durationMs: 501,
      blockingMs: 301,
      scripts: [80, 60, 40].map((duration) => ({
        durationMs: duration,
        function: `work${duration}`,
        forcedLayoutMs: 2,
      })),
    });
    expect(JSON.parse(warn.mock.calls[1][1])).toMatchObject({
      blockingMs: 0,
      scripts: [],
    });
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    warn.mockRestore();
  }
});

it.each(["pointerup", "pointercancel"] as const)(
  "acknowledges after %s reaches the window outside the document",
  async (event) => {
    const save = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ state }) => {
        usePageInputActivity("chapter", "B", state);
        usePageEditHandoff(state, save);
      },
      { initialProps: { state: idle } },
    );
    act(() => fireEvent.pointerDown(document, { pointerId: 7 }));
    rerender({ state: handingOff });
    act(() => {
      if (event === "pointerup") fireEvent.pointerUp(window, { pointerId: 7 });
      else fireEvent.pointerCancel(window, { pointerId: 7 });
    });
    await waitFor(() =>
      expect(acknowledge).toHaveBeenCalledWith({ requestId: "handoff" }),
    );
    expect(save).toHaveBeenCalledOnce();
  },
);

it("releases a lost pointer on window blur but still waits for a durable image write", async () => {
  const save = vi.fn(async () => undefined);
  const finishImage = pendingPageEdits.begin("chapter", "B");
  const { result, rerender } = renderHook(
    ({ state }) => {
      const active = usePageInputActivity("chapter", "B", state);
      usePageEditHandoff(state, save);
      return active;
    },
    { initialProps: { state: idle } },
  );
  act(() => fireEvent.pointerDown(document, { pointerId: 7 }));
  rerender({ state: handingOff });
  act(() => fireEvent.blur(window));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(result.current.has("chapter/B")).toBe(true);
  expect(save).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
  act(() => finishImage());
  await waitFor(() =>
    expect(acknowledge).toHaveBeenCalledWith({ requestId: "handoff" }),
  );
});

it("waits for edits begun during finishing and blocks a new text input", async () => {
  const save = vi.fn(async () => undefined);
  const finishImage = pendingPageEdits.begin("chapter", "B");
  renderHook(() => {
    usePageInputActivity("chapter", "B", handingOff);
    usePageEditHandoff(handingOff, save);
  });
  act(() => fireEvent.pointerDown(document, { pointerId: 9 }));
  const newInput = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    data: "new",
  });
  const editor = document.createElement("div");
  editor.className = "editor-panel";
  document.body.append(editor);
  editor.dispatchEvent(newInput);
  expect(newInput.defaultPrevented).toBe(true);
  const settingsInput = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(settingsInput);
  expect(settingsInput.defaultPrevented).toBe(false);
  editor.remove();
  act(() => finishImage());
  await act(async () => {
    await Promise.resolve();
  });
  expect(save).not.toHaveBeenCalled();
  act(() => fireEvent.pointerUp(document, { pointerId: 9 }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
});

it.each(["pointer", "composition"] as const)(
  "finishes a %s input before saving and acknowledging its page",
  async (input) => {
    let text = "draft";
    const saved: string[] = [];
    const save = vi.fn(async () => {
      saved.push(text);
    });
    const { result, rerender } = renderHook(
      ({ state }) => {
        const active = usePageInputActivity("chapter", "B", state);
        usePageEditHandoff(state, save);
        return active;
      },
      { initialProps: { state: idle } },
    );
    act(() => {
      if (input === "pointer")
        fireEvent.pointerDown(document, { pointerId: 7 });
      else fireEvent.compositionStart(document);
    });
    expect(result.current.has("chapter/B")).toBe(true);
    rerender({ state: handingOff });
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    if (input === "composition") {
      act(() => fireEvent.blur(window));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(save).not.toHaveBeenCalled();
      expect(acknowledge).not.toHaveBeenCalled();
    }
    act(() => {
      if (input === "pointer") fireEvent.pointerUp(document, { pointerId: 7 });
      else fireEvent.compositionEnd(document);
      text = "입력 완료";
    });
    await waitFor(() =>
      expect(acknowledge).toHaveBeenCalledWith({ requestId: "handoff" }),
    );
    expect(saved).toEqual(["입력 완료"]);
    expect(save).toHaveBeenCalledWith("chapter", "B");
  },
);

it("waits for a pending image write on the target, while an unrelated page remains independent", async () => {
  const finishOther = pendingPageEdits.begin("chapter", "A");
  const finishImage = pendingPageEdits.begin("chapter", "B");
  const save = vi.fn(async () => undefined);
  renderHook(() => usePageEditHandoff(handingOff, save));
  await act(async () => {
    await Promise.resolve();
  });
  expect(save).not.toHaveBeenCalled();
  act(() => finishImage());
  await waitFor(() =>
    expect(acknowledge).toHaveBeenCalledWith({ requestId: "handoff" }),
  );
  expect(save).toHaveBeenCalledWith("chapter", "B");
  finishOther();
});

it("reports a save failure and saves again only for a new handoff request", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  const { rerender } = renderHook(
    ({ state }) => usePageEditHandoff(state, save),
    { initialProps: { state: handingOff } },
  );
  await waitFor(() =>
    expect(acknowledge).toHaveBeenCalledWith({
      requestId: "handoff",
      error: "disk full",
    }),
  );
  rerender({ state: { ...handingOff, version: 3 } });
  expect(save).toHaveBeenCalledOnce();
  rerender({
    state: {
      ...handingOff,
      version: 4,
      pages: handingOff.pages.map((page) => ({ ...page, requestId: "retry" })),
    },
  });
  await waitFor(() =>
    expect(acknowledge).toHaveBeenCalledWith({ requestId: "retry" }),
  );
  expect(save).toHaveBeenCalledTimes(2);
});

it("logs the stalled save phase and clears its diagnostic timer after acknowledgement", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let finishSave!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishSave = resolve;
      }),
  );
  try {
    renderHook(() => usePageEditHandoff(handingOff, save));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(warn).toHaveBeenCalledWith(
      "Page edit handoff is still pending",
      JSON.stringify({
        requestId: "handoff",
        chapterId: "chapter",
        pageId: "B",
        stage: "save-page",
        activeInput: false,
        visibility: document.visibilityState,
        focused: document.hasFocus(),
      }),
    );
    await act(async () => {
      finishSave();
    });
    expect(acknowledge).toHaveBeenCalledWith({ requestId: "handoff" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    cleanup();
    warn.mockRestore();
    vi.useRealTimers();
  }
});
