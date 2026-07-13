// @vitest-environment jsdom

import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InpaintingMaskStroke } from "../src/shared/inpaintingTypes";
import type { MangaPage } from "../src/shared/libraryTypes";
import { useWorkspaceInpaintingPointerHandlers } from "../src/renderer/src/hooks/useWorkspaceInpaintingPointerHandlers";

type RetouchHarnessApi = {
  appendRetouchPoint: ReturnType<typeof vi.fn>;
  applyRetouchPoints: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
  getRenderCount: () => number;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workspace retouch pointer performance", () => {
  it("batches a hover burst into one compositor cursor frame without rerendering", () => {
    const frames = installAnimationFrameController();
    const api = renderRetouchHarness();
    const stage = screen.getByTestId("retouch-stage");
    const initialRenderCount = api.current.getRenderCount();

    for (let coordinate = 1; coordinate <= 99; coordinate += 1) {
      fireEvent.pointerMove(stage, {
        clientX: coordinate,
        clientY: coordinate,
        pointerId: 1,
      });
    }

    expect(api.current.getRenderCount()).toBe(initialRenderCount);
    expect(api.current.getBounds).toHaveBeenCalledTimes(1);
    expect(frames.count()).toBe(1);
    expect(api.current.appendRetouchPoint).not.toHaveBeenCalled();

    act(() => frames.flush());

    const cursor = stage.querySelector<HTMLElement>(
      "[data-retouch-live-cursor]",
    );
    expect(cursor?.style.transform).toContain("translate3d(99px, 99px, 0)");
    expect(cursor?.style.visibility).toBe("visible");
  });

  it("keeps drawing samples in refs and applies one brush operation on pointerup", () => {
    const frames = installAnimationFrameController();
    const api = renderRetouchHarness();
    const stage = screen.getByTestId("retouch-stage");
    const initialRenderCount = api.current.getRenderCount();

    fireEvent.pointerDown(stage, { clientX: 10, clientY: 10, pointerId: 3 });
    for (const coordinate of [20, 30, 40, 50]) {
      fireEvent.pointerMove(stage, {
        clientX: coordinate,
        clientY: coordinate,
        pointerId: 3,
      });
    }
    fireEvent.pointerUp(stage, { clientX: 50, clientY: 50, pointerId: 3 });

    expect(api.current.getRenderCount()).toBe(initialRenderCount);
    expect(api.current.getBounds).toHaveBeenCalledTimes(1);
    expect(api.current.appendRetouchPoint).toHaveBeenCalledTimes(5);
    expect(api.current.applyRetouchPoints).toHaveBeenCalledTimes(1);
    expect(api.current.applyRetouchPoints).toHaveBeenCalledWith("brush", [
      { x: 100, y: 100 },
      { x: 200, y: 200 },
      { x: 300, y: 300 },
      { x: 400, y: 400 },
      { x: 500, y: 500 },
    ]);
    expect(frames.count()).toBe(0);
  });
});

function renderRetouchHarness(): React.MutableRefObject<RetouchHarnessApi> {
  const api = React.createRef<RetouchHarnessApi>();
  render(
    <RetouchHarness
      onReady={(nextApi) => {
        api.current = nextApi;
      }}
    />,
  );
  if (!api.current) {
    throw new Error("Retouch harness did not initialize.");
  }
  return api as React.MutableRefObject<RetouchHarnessApi>;
}

function RetouchHarness({
  onReady,
}: {
  onReady: (api: RetouchHarnessApi) => void;
}): React.JSX.Element {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const drawingRef = useRef(false);
  const pointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const selectedPageIdRef = useRef<string | null>("page-1");
  const [, setPaintColor] = useState("#ffffff");
  const [, setSelectedBlockId] = useState<string | null>(null);
  const [, setMasks] = useState<Record<string, InpaintingMaskStroke[]>>({});
  const page = useMemo(makePage, []);
  const appendRetouchPoint = useMemo(() => vi.fn(), []);
  const applyRetouchPoints = useMemo(() => vi.fn(async () => undefined), []);
  const getBounds = useMemo(() => vi.fn(() => makeDomRect()), []);
  const appendPoint = useCallback(
    (point: { x: number; y: number }) => {
      const next = { x: Math.round(point.x), y: Math.round(point.y) };
      pointsRef.current.push(next);
      lastPointRef.current = point;
      appendRetouchPoint(next);
      return next;
    },
    [appendRetouchPoint],
  );
  const handlers = useWorkspaceInpaintingPointerHandlers({
    appendRetouchPoint: appendPoint,
    applyRetouchPoints,
    imageRef,
    inpaintingBrushRadius: 28,
    inpaintingPaintColor: "#ffffff",
    inpaintingRetouchDrawingRef: drawingRef,
    inpaintingRetouchPointsRef: pointsRef,
    inpaintingTool: "brush",
    inpaintingToolActive: true,
    jobActive: false,
    lastInpaintingRetouchPointRef: lastPointRef,
    pushStatus: () => undefined,
    selectedPage: page,
    selectedPageIdRef,
    selectedPageImagePath: page.imagePath,
    setInpaintingPaintColor: setPaintColor,
    setPatternMaskStrokesByPage: setMasks,
    setSelectedBlockId,
    stageRef,
  });

  useLayoutEffect(() => {
    if (imageRef.current) imageRef.current.getBoundingClientRect = getBounds;
    onReady({
      appendRetouchPoint,
      applyRetouchPoints,
      getBounds,
      getRenderCount: () => renderCountRef.current,
    });
  }, [appendRetouchPoint, applyRetouchPoints, getBounds, onReady]);

  return (
    <div
      data-testid="retouch-stage"
      onPointerCancel={handlers.onPointerUp}
      onPointerDown={handlers.onPointerDown}
      onPointerLeave={handlers.onPointerLeave}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      ref={stageRef}
    >
      <img alt="" ref={imageRef} />
      <div data-retouch-live-cursor="" />
    </div>
  );
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
      const queued = Array.from(callbacks.values());
      callbacks.clear();
      for (const callback of queued) callback(16.67);
    },
  };
}

function makeDomRect(): DOMRect {
  return {
    bottom: 100,
    height: 100,
    left: 0,
    right: 100,
    top: 0,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page-1.png",
    imagePath: "page-1.png",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
