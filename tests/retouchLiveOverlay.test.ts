// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendRetouchStrokePoint,
  beginRetouchStroke,
  clearRetouchLiveOverlay,
  queueRetouchCursor,
} from "../src/renderer/src/lib/retouchLiveOverlay";

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
});

function makeStage(context: CanvasRenderingContext2D & MockContext): {
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
  arc: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  clip: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
  setTransform: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
};

function makeCanvasContext(): CanvasRenderingContext2D & MockContext {
  const methods: MockContext = {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
  };
  return methods as unknown as CanvasRenderingContext2D & MockContext;
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
