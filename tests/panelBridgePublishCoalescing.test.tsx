/** @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PanelCommand,
  PanelId,
  PanelSyncState,
} from "../src/shared/panelBridgeTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { usePanelBridgeHost } from "../src/renderer/src/panels/usePanelBridgeHost";
import { pendingPageEdits } from "../src/renderer/src/lib/pageEditBarrier";

type PanelWindowsListener = (ids: PanelId[]) => void;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("panel bridge publishing", () => {
  it("waits for a detached editor acknowledgement and keeps its preceding commands", async () => {
    const frames = installAnimationFrameController();
    let command: (value: PanelCommand) => void = () => {};
    let windows: (ids: PanelId[]) => void = () => {};
    const publish = vi.fn<
      (state: PanelSyncState) => Promise<{ published: boolean }>
    >(async () => ({
      published: true,
    }));
    window.mangaApi = createTestMangaGatewayStub({
      onPanelCommand: (listener) => {
        command = listener;
        return () => {};
      },
      onPanelWindowsChanged: (listener) => {
        windows = listener;
        return () => {};
      },
      publishPanelState: publish,
    });
    const onCommand = vi.fn();
    const view = renderHook(() =>
      usePanelBridgeHost({
        syncState: {
          ...makePanelState(1),
          editPage: { chapterId: "chapter", pageId: "B" },
        },
        onCommand,
      }),
    );
    act(() => windows(["editor"]));
    let done = false;
    let saved!: Promise<void>;
    act(() => {
      saved = pendingPageEdits.flushEditors("chapter", "B").then(() => {
        done = true;
      });
    });
    act(() => frames.flush());
    await waitFor(() => expect(publish).toHaveBeenCalled());
    const request = publish.mock.calls.at(-1)?.[0].editHandoff;
    if (!request) throw new Error("Missing editor handoff request");
    expect(request.pageId).toBe("B");
    expect(done).toBe(false);
    expect(pendingPageEdits.getActivePages().has("chapter/B")).toBe(true);
    await act(async () => {
      command({
        type: "updateBlock",
        blockId: "block",
        patch: { translatedText: "한글 완료" },
      });
      command({ type: "finishPageEdits", requestId: request.requestId });
      await saved;
    });
    expect(onCommand).toHaveBeenCalledOnce();
    expect(done).toBe(true);
    await pendingPageEdits.flushEditors("chapter", "other");
    view.unmount();
  });
  it("does not publish without a pop-out and coalesces an open-panel burst", async () => {
    const frames = installAnimationFrameController();
    const bridge = installPanelBridge();
    const { rerender } = renderHook(
      ({ state }) =>
        usePanelBridgeHost({ syncState: state, onCommand: vi.fn() }),
      { initialProps: { state: makePanelState(1) } },
    );

    rerender({ state: makePanelState(2) });
    rerender({ state: makePanelState(3) });
    act(() => frames.flush());
    expect(bridge.publishPanelState).not.toHaveBeenCalled();

    act(() => bridge.emitWindowsChanged(["editor"]));
    rerender({ state: makePanelState(4) });
    rerender({ state: makePanelState(5) });
    expect(frames.count()).toBe(1);

    act(() => frames.flush());
    await waitFor(() =>
      expect(bridge.publishPanelState).toHaveBeenCalledTimes(1),
    );
    expect(bridge.publishPanelState).toHaveBeenLastCalledWith(
      makePanelState(5),
    );

    rerender({ state: makePanelState(5) });
    expect(frames.count()).toBe(0);
    act(() => frames.flush());
    expect(bridge.publishPanelState).toHaveBeenCalledTimes(1);
  });

  it("serializes an in-flight publish and sends the latest trailing state", async () => {
    const frames = installAnimationFrameController();
    const firstPublish = deferred<{ published: boolean }>();
    const bridge = installPanelBridge([
      firstPublish.promise,
      Promise.resolve({ published: true }),
    ]);
    const { rerender } = renderHook(
      ({ state }) =>
        usePanelBridgeHost({ syncState: state, onCommand: vi.fn() }),
      { initialProps: { state: makePanelState(1) } },
    );

    act(() => bridge.emitWindowsChanged(["editor"]));
    act(() => frames.flush());
    await waitFor(() =>
      expect(bridge.publishPanelState).toHaveBeenCalledTimes(1),
    );

    rerender({ state: makePanelState(2) });
    rerender({ state: makePanelState(3) });
    act(() => frames.flush());
    expect(bridge.publishPanelState).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstPublish.resolve({ published: true });
      await firstPublish.promise;
    });
    await waitFor(() => expect(frames.count()).toBe(1));
    act(() => frames.flush());

    await waitFor(() =>
      expect(bridge.publishPanelState).toHaveBeenCalledTimes(2),
    );
    expect(bridge.publishPanelState).toHaveBeenLastCalledWith(
      makePanelState(3),
    );
  });
});

function installPanelBridge(
  publishResults: Array<Promise<{ published: boolean }>> = [],
): {
  emitWindowsChanged: (ids: PanelId[]) => void;
  publishPanelState: ReturnType<typeof vi.fn>;
} {
  let windowsListener: PanelWindowsListener | null = null;
  const publishPanelState = vi.fn((state: PanelSyncState) => {
    void state;
    return publishResults.shift() ?? Promise.resolve({ published: true });
  });
  Object.defineProperty(window, "mangaApi", {
    configurable: true,
    value: createTestMangaGatewayStub({
      closePanelWindow: async () => ({ closed: true }),
      onPanelCommand: () => () => undefined,
      onPanelWindowsChanged: (listener) => {
        windowsListener = listener;
        return () => undefined;
      },
      openPanelWindow: async () => ({ opened: true }),
      publishPanelState,
    }),
  });
  return {
    emitWindowsChanged(ids) {
      if (!windowsListener)
        throw new Error("Panel listener was not registered.");
      windowsListener(ids);
    },
    publishPanelState,
  };
}

function makePanelState(selectedBlockCount: number): PanelSyncState {
  return {
    blockStylePresets: [],
    areaTranslateAvailable: true,
    areaTranslateSelecting: false,
    disableChapterApply: false,
    editorDisabled: false,
    editorTextTabRequestToken: 0,
    formatSelection: { common: {}, mixedFields: [] },
    selectionKey: "[]",
    selectedBlock: null,
    selectedBlockCount,
    selectedPageSize: { width: 1200, height: 1600 },
    transformMode: "select",
  };
}

function installAnimationFrameController(): {
  count: () => number;
  flush: () => void;
} {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id);
  });
  return {
    count: () => callbacks.size,
    flush: () => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(16.67);
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise)
        throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    },
  };
}
