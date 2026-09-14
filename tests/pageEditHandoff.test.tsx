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
