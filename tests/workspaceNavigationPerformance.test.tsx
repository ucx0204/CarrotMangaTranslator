// @vitest-environment jsdom

import React, { useLayoutEffect, useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspacePanHandlers } from "../src/renderer/src/hooks/useWorkspacePanHandlers";
import { useWorkspaceWheelZoom } from "../src/renderer/src/hooks/useWorkspaceWheelZoom";

afterEach(() => {
  cleanup();
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

    view.unmount();
    fireEvent.wheel(panel, { ctrlKey: true, deltaY: 1 });
    expect(frames.count()).toBe(0);
    expect(zoomOut).not.toHaveBeenCalled();
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
  zoomIn,
  zoomOut,
}: {
  zoomIn: () => void;
  zoomOut: () => void;
}): React.JSX.Element {
  const workspacePanelRef = useRef<HTMLElement | null>(null);
  useWorkspaceWheelZoom({ workspacePanelRef, zoomIn, zoomOut });
  return <section data-testid="wheel-panel" ref={workspacePanelRef} />;
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
