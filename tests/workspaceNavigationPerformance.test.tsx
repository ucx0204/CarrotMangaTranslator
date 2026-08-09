// @vitest-environment jsdom

import React, { useLayoutEffect, useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspacePanHandlers } from "../src/renderer/src/hooks/useWorkspacePanHandlers";
import { usePageNavigationHandlers } from "../src/renderer/src/hooks/usePageNavigationHandlers";
import { useWorkspaceWheelZoom } from "../src/renderer/src/hooks/useWorkspaceWheelZoom";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type { KeybindingOverrides } from "../src/shared/shortcutSettings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workspace navigation performance", () => {
  it("coalesces a pan burst into one scroll write frame", () => {
    const frames = installAnimationFrameController();
    const api = React.createRef<PanHarnessApi>();
    render(<PanHarness onReady={(value) => (api.current = value)} />);
    const stage = screen.getByTestId("pan-stage");
    const panel = screen.getByTestId("pan-panel");
    panel.scrollLeft = 500;
    panel.scrollTop = 400;

    fireEvent.pointerDown(stage, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 2,
    });
    const renderCount = api.current?.getRenderCount();
    for (let coordinate = 11; coordinate <= 99; coordinate += 1) {
      fireEvent.pointerMove(stage, {
        clientX: coordinate,
        clientY: coordinate,
        pointerId: 2,
      });
    }

    expect(api.current?.getRenderCount()).toBe(renderCount);
    expect(frames.count()).toBe(1);
    expect(panel.scrollLeft).toBe(500);
    act(() => frames.flush());
    expect(panel.scrollLeft).toBe(411);
    expect(panel.scrollTop).toBe(311);

    fireEvent.pointerUp(stage, {
      clientX: 100,
      clientY: 100,
      pointerId: 2,
    });
    expect(panel.scrollLeft).toBe(410);
    expect(panel.scrollTop).toBe(310);
  });

  it("coalesces a ctrl-wheel burst and removes its listener on unmount", () => {
    const frames = installAnimationFrameController();
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    const view = render(<WheelHarness zoomIn={zoomIn} zoomOut={zoomOut} />);
    const panel = screen.getByTestId("wheel-panel");

    for (let index = 0; index < 80; index += 1) {
      fireEvent.wheel(panel, { ctrlKey: true, deltaY: -1 });
    }
    expect(zoomIn).not.toHaveBeenCalled();
    expect(zoomOut).not.toHaveBeenCalled();
    expect(frames.count()).toBe(1);

    act(() => frames.flush());
    expect(zoomIn).toHaveBeenCalledTimes(1);
    expect(zoomOut).not.toHaveBeenCalled();

    fireEvent.wheel(panel, { ctrlKey: true, deltaY: 1 });
    act(() => frames.flush());
    expect(zoomOut).toHaveBeenCalledTimes(1);

    view.unmount();
    fireEvent.wheel(panel, { ctrlKey: true, deltaY: 1 });
    expect(frames.count()).toBe(0);
    expect(zoomOut).toHaveBeenCalledTimes(1);
  });

  it("consumes matching bare and modified wheel bindings before page navigation", () => {
    const frames = installAnimationFrameController();
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    render(
      <WheelHarness
        overrides={{
          "zoom-in": "wheelup",
          "zoom-out": "alt+wheeldown",
        }}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
      />,
    );
    const panel = screen.getByTestId("wheel-panel");
    const pageNavigation = vi.fn();
    panel.addEventListener("wheel", (event) => {
      if (!event.defaultPrevented) {
        pageNavigation();
      }
    });

    fireEvent.wheel(panel, { deltaY: -80 });
    expect(pageNavigation).not.toHaveBeenCalled();
    act(() => frames.flush());
    expect(zoomIn).toHaveBeenCalledOnce();

    fireEvent.wheel(panel, { altKey: true, deltaY: 80 });
    expect(pageNavigation).not.toHaveBeenCalled();
    act(() => frames.flush());
    expect(zoomOut).toHaveBeenCalledOnce();

    fireEvent.wheel(panel, { deltaY: 80 });
    expect(pageNavigation).toHaveBeenCalledOnce();
  });

  it("blocks Chromium page zoom after Ctrl+wheel is reassigned", () => {
    const frames = installAnimationFrameController();
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    render(
      <WheelHarness
        overrides={{
          "zoom-in": "wheelup",
          "zoom-out": "alt+wheeldown",
        }}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
      />,
    );
    const panel = screen.getByTestId("wheel-panel");
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -80,
    });

    panel.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(frames.count()).toBe(0);
    expect(zoomIn).not.toHaveBeenCalled();
    expect(zoomOut).not.toHaveBeenCalled();
  });

  it("routes a custom wheel zoom ahead of the fixed page handler", () => {
    const frames = installAnimationFrameController();
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const zoomIn = vi.fn();
    render(<WheelAndPageHarness zoomIn={zoomIn} />);
    const panel = screen.getByTestId("wheel-page-panel");

    fireEvent.wheel(panel, { deltaY: -80 });
    act(() => frames.flush());

    expect(zoomIn).toHaveBeenCalledOnce();
    expect(screen.getByTestId("selected-page").textContent).toBe("page-2");
    expect(screen.getByTestId("selected-block-ids").textContent).toBe(
      "block-a,block-b",
    );

    fireEvent.wheel(panel, { deltaY: 80 });
    expect(screen.getByTestId("selected-page").textContent).toBe("page-3");
    expect(screen.getByTestId("selected-block-ids").textContent).toBe("");
    now.mockRestore();
  });
});

type PanHarnessApi = {
  getRenderCount: () => number;
};

function PanHarness({
  onReady,
}: {
  onReady: (api: PanHarnessApi) => void;
}): React.JSX.Element {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const workspacePanelRef = useRef<HTMLElement | null>(null);
  const handlers = useWorkspacePanHandlers({ stageRef, workspacePanelRef });
  useLayoutEffect(() => {
    onReady({ getRenderCount: () => renderCountRef.current });
  }, [onReady]);
  return (
    <section data-testid="pan-panel" ref={workspacePanelRef}>
      <div
        data-testid="pan-stage"
        onPointerDown={handlers.startPan}
        onPointerMove={handlers.onPanPointerMove}
        onPointerUp={handlers.onPanPointerUp}
        ref={stageRef}
      />
    </section>
  );
}

function WheelHarness({
  overrides,
  zoomIn,
  zoomOut,
}: {
  overrides?: KeybindingOverrides;
  zoomIn: () => void;
  zoomOut: () => void;
}): React.JSX.Element {
  const workspacePanelRef = useRef<HTMLElement | null>(null);
  useWorkspaceWheelZoom({ overrides, workspacePanelRef, zoomIn, zoomOut });
  return <section data-testid="wheel-panel" ref={workspacePanelRef} />;
}

function WheelAndPageHarness({
  zoomIn,
}: {
  zoomIn: () => void;
}): React.JSX.Element {
  const workspacePanelRef = useRef<HTMLElement | null>(null);
  const currentChapterRef = useRef<ChapterSnapshot | null>(
    makeNavigationChapter(),
  );
  const selectedPageIdRef = useRef<string | null>("page-2");
  const selectedBlockIdRef = useRef<string | null>("block-a");
  const [selectedPageId, setSelectedPageId] = useState<string | null>("page-2");
  const [, setSelectedBlockId] = useState<string | null>("block-a");
  const [selectedBlockIds, setSelectedBlockIds] = useState([
    "block-a",
    "block-b",
  ]);
  usePageNavigationHandlers({
    currentChapterRef,
    modalOpen: false,
    selectedBlockIdRef,
    selectedPageIdRef,
    setSelectedBlockId,
    setSelectedBlockIds,
    setSelectedPageId,
    workspacePanelRef,
  });
  useWorkspaceWheelZoom({
    overrides: { "zoom-in": "wheelup", "zoom-out": "alt+wheeldown" },
    workspacePanelRef,
    zoomIn,
    zoomOut: () => undefined,
  });
  return (
    <section data-testid="wheel-page-panel" ref={workspacePanelRef}>
      <span data-testid="selected-page">{selectedPageId}</span>
      <span data-testid="selected-block-ids">{selectedBlockIds.join(",")}</span>
    </section>
  );
}

function makeNavigationChapter(): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page-1", "page-2", "page-3"],
    pages: ["page-1", "page-2", "page-3"].map((id) => ({
      id,
      name: `${id}.png`,
      imagePath: `${id}.png`,
      dataUrl: "",
      width: 100,
      height: 100,
      blocks: [],
      analysisStatus: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function installAnimationFrameController(): {
  count: () => number;
  flush: () => void;
} {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      callbacks.delete(id);
    }),
  );
  return {
    count: () => callbacks.size,
    flush: () => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(16.67);
    },
  };
}
