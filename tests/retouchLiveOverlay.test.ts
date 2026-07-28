// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  appendRetouchStrokePoint,
  beginRetouchShape,
  beginRetouchStroke,
  clearRetouchLiveOverlay,
  queueRetouchCursor,
  updateRetouchShape,
} from "../src/renderer/src/lib/retouchLiveOverlay";
import type { RetouchCanvasContext } from "../src/renderer/src/lib/retouchCanvasContext";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("retouch live overlay", () => {
  it("publishes cursor and incremental brush drawing at most once per frame", () => {
    const frames = installAnimationFrameController();
    const context = makeCanvasContext();
    const { canvas, cursor, stage } = makeStage(context);
    const geometry = {
      displayHeight: 100,
      displayWidth: 100,
      imageHeight: 1000,
      imageWidth: 1000,
    };

    beginRetouchStroke(stage, { x: 10, y: 10 }, geometry, {
      color: "#ffffff",
      mode: "brush",
      radiusPx: 20,
    });
    for (let index = 1; index <= 50; index += 1) {
      const point = { x: (index + 1) * 10, y: (index + 1) * 10 };
      appendRetouchStrokePoint(stage, point, geometry);
      queueRetouchCursor(stage, point, geometry, 20);
    }

    expect(frames.count()).toBe(1);
    expect(context.stroke).not.toHaveBeenCalled();

    frames.flush();

    expect(frames.count()).toBe(0);
    expect(canvas.hidden).toBe(false);
    expect(context.fill).toHaveBeenCalledTimes(1);
    expect(context.stroke).toHaveBeenCalledTimes(50);
    expect(cursor.style.transform).toContain("translate3d(51px, 51px, 0)");
    clearRetouchLiveOverlay(stage);
  });

  it("redraws the latest filled rectangle or ellipse once per frame", () => {
    const frames = installAnimationFrameController();
    const context = makeCanvasContext();
    const { canvas, stage } = makeStage(context);
    const geometry = {
      displayHeight: 100,
      displayWidth: 100,
      imageHeight: 1000,
      imageWidth: 1000,
    };

    beginRetouchShape(stage, { x: 100, y: 200 }, geometry, {
      color: "#ffffff",
      kind: "rectangle",
    });
    updateRetouchShape(stage, { x: 700, y: 800 }, geometry);
    updateRetouchShape(stage, { x: 800, y: 900 }, geometry);

    expect(frames.count()).toBe(1);
    expect(context.fillRect).not.toHaveBeenCalled();

    frames.flush();

    expect(canvas.hidden).toBe(false);
    expect(context.fillRect).toHaveBeenCalledOnce();
    expect(context.fillRect).toHaveBeenLastCalledWith(10, 20, 70, 70);

    beginRetouchShape(stage, { x: 900, y: 800 }, geometry, {
      color: "#ffcc00",
      kind: "ellipse",
    });
    updateRetouchShape(stage, { x: 100, y: 200 }, geometry);
    frames.flush();

    expect(context.ellipse).toHaveBeenCalledOnce();
    expect(context.ellipse).toHaveBeenLastCalledWith(
      50,
      50,
      40,
      30,
      0,
      0,
      Math.PI * 2,
    );
    clearRetouchLiveOverlay(stage);
  });
});

function makeStage(context: RetouchCanvasContext & MockContext): {
  canvas: HTMLCanvasElement;
  cursor: HTMLDivElement;
  stage: HTMLDivElement;
} {
  const stage = document.createElement("div");
  const canvas = document.createElement("canvas");
  canvas.dataset.retouchLiveCanvas = "";
  Object.defineProperty(canvas, "getContext", {
    configurable: true,
    value: vi.fn(() => context),
  });
  const cursor = document.createElement("div");
  cursor.dataset.retouchLiveCursor = "";
  stage.append(canvas, cursor);
  return { canvas, cursor, stage };
}

type MockContext = {
  arc: Mock<RetouchCanvasContext["arc"]>;
  beginPath: Mock<RetouchCanvasContext["beginPath"]>;
  clearRect: Mock<RetouchCanvasContext["clearRect"]>;
  clip: Mock<RetouchCanvasContext["clip"]>;
  closePath: Mock<RetouchCanvasContext["closePath"]>;
  drawImage: Mock<RetouchCanvasContext["drawImage"]>;
  ellipse: Mock<RetouchCanvasContext["ellipse"]>;
  fill: Mock<RetouchCanvasContext["fill"]>;
  fillRect: Mock<RetouchCanvasContext["fillRect"]>;
  lineTo: Mock<RetouchCanvasContext["lineTo"]>;
  moveTo: Mock<RetouchCanvasContext["moveTo"]>;
  restore: Mock<RetouchCanvasContext["restore"]>;
  save: Mock<RetouchCanvasContext["save"]>;
  setLineDash: Mock<RetouchCanvasContext["setLineDash"]>;
  setTransform: Mock<RetouchCanvasContext["setTransform"]>;
  stroke: Mock<RetouchCanvasContext["stroke"]>;
};

function makeCanvasContext(): RetouchCanvasContext & MockContext {
  return {
    arc: vi.fn<RetouchCanvasContext["arc"]>(),
    beginPath: vi.fn<RetouchCanvasContext["beginPath"]>(),
    clearRect: vi.fn<RetouchCanvasContext["clearRect"]>(),
    clip: vi.fn<RetouchCanvasContext["clip"]>(),
    closePath: vi.fn<RetouchCanvasContext["closePath"]>(),
    drawImage: vi.fn<RetouchCanvasContext["drawImage"]>(),
    ellipse: vi.fn<RetouchCanvasContext["ellipse"]>(),
    fill: vi.fn<RetouchCanvasContext["fill"]>(),
    fillRect: vi.fn<RetouchCanvasContext["fillRect"]>(),
    fillStyle: "#000000",
    globalAlpha: 1,
    lineCap: "butt",
    lineJoin: "miter",
    lineWidth: 1,
    lineTo: vi.fn<RetouchCanvasContext["lineTo"]>(),
    moveTo: vi.fn<RetouchCanvasContext["moveTo"]>(),
    restore: vi.fn<RetouchCanvasContext["restore"]>(),
    save: vi.fn<RetouchCanvasContext["save"]>(),
    setLineDash: vi.fn<RetouchCanvasContext["setLineDash"]>(),
    setTransform: vi.fn<RetouchCanvasContext["setTransform"]>(),
    stroke: vi.fn<RetouchCanvasContext["stroke"]>(),
    strokeStyle: "#000000",
  } satisfies RetouchCanvasContext & MockContext;
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
