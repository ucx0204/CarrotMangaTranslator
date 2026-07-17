// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallProgressOverlay } from "../src/renderer/src/components/InstallProgressOverlay";
import type { JobState } from "../src/shared/jobTypes";

let nextFrameId = 1;
let queuedFrames = new Map<number, FrameRequestCallback>();
let resizeObservers: ResizeObserverMock[] = [];

beforeEach(() => {
  nextFrameId = 1;
  queuedFrames = new Map();
  resizeObservers = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback): number => {
      const id = nextFrameId;
      nextFrameId += 1;
      queuedFrames.set(id, callback);
      return id;
    },
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queuedFrames.delete(id);
  });
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InstallProgressOverlay log pinning", () => {
  it("keeps following logs after the 80-line window starts sliding", () => {
    const view = renderOverlay(makeJob(makeLines(1, 80)));
    const geometry = configureLogGeometry(1_000, 180);
    flushAnimationFrames();
    expect(geometry.scrollTop).toBe(820);

    geometry.scrollHeight = 1_240;
    rerenderOverlay(view, makeJob(makeLines(2, 81)));

    expect(geometry.scrollTop).toBe(1_060);
  });

  it("does not mistake layout-driven scroll drift for user intent", () => {
    const view = renderOverlay(makeJob(makeLines(1, 30)));
    const geometry = configureLogGeometry(900, 180);
    flushAnimationFrames();

    geometry.scrollTop = 500;
    fireEvent.scroll(screen.getByLabelText("설치 로그"));
    geometry.scrollHeight = 1_100;
    rerenderOverlay(view, makeJob([...makeLines(1, 30), longLine()]));

    expect(geometry.scrollTop).toBe(920);
  });

  it("preserves even a small intentional wheel-up across new logs", () => {
    const view = renderOverlay(makeJob(makeLines(1, 30)));
    const geometry = configureLogGeometry(900, 180);
    flushAnimationFrames();
    const log = screen.getByLabelText("설치 로그");

    fireEvent.wheel(log, { deltaY: -120 });
    geometry.scrollTop = 714;
    fireEvent.scroll(log);
    geometry.scrollHeight = 1_100;
    rerenderOverlay(view, makeJob([...makeLines(1, 30), "new line"]));
    flushAnimationFrames();

    expect(geometry.scrollTop).toBe(714);
  });

  it("preserves a scrollbar pointer drag across new logs", () => {
    const view = renderOverlay(makeJob(makeLines(1, 30)));
    const geometry = configureLogGeometry(900, 180);
    flushAnimationFrames();
    const log = screen.getByLabelText("설치 로그");

    fireEvent.pointerDown(log, { pointerId: 1 });
    geometry.scrollTop = 360;
    fireEvent.scroll(log);
    fireEvent.pointerUp(log, { pointerId: 1 });
    geometry.scrollHeight = 1_100;
    rerenderOverlay(view, makeJob([...makeLines(1, 30), "new line"]));
    flushAnimationFrames();

    expect(geometry.scrollTop).toBe(360);
  });

  it("rejoins automatic following after the user returns to the bottom", () => {
    const view = renderOverlay(makeJob(makeLines(1, 30)));
    const geometry = configureLogGeometry(900, 180);
    flushAnimationFrames();
    const log = screen.getByLabelText("설치 로그");

    fireEvent.wheel(log, { deltaY: -120 });
    geometry.scrollTop = 420;
    fireEvent.scroll(log);
    geometry.scrollTop = geometry.scrollHeight - geometry.clientHeight;
    fireEvent.scroll(log);
    geometry.scrollHeight = 1_180;
    rerenderOverlay(view, makeJob([...makeLines(1, 30), "new line"]));

    expect(geometry.scrollTop).toBe(1_000);
  });

  it("keeps the bottom pinned when a long wrapped line changes content height", () => {
    renderOverlay(makeJob([...makeLines(1, 20), longLine()]));
    const geometry = configureLogGeometry(760, 180);
    flushAnimationFrames();

    geometry.scrollHeight = 1_260;
    notifyContentResize();

    expect(geometry.scrollTop).toBe(1_080);
  });

  it("cancels a queued automatic scroll when the user moves up", () => {
    const view = renderOverlay(makeJob(makeLines(1, 30)));
    const geometry = configureLogGeometry(900, 180);
    flushAnimationFrames();

    geometry.scrollHeight = 1_040;
    rerenderOverlay(view, makeJob([...makeLines(1, 30), "new line"]));
    const log = screen.getByLabelText("설치 로그");
    fireEvent.wheel(log, { deltaY: -120 });
    geometry.scrollTop = 360;
    fireEvent.scroll(log);
    flushAnimationFrames();

    expect(geometry.scrollTop).toBe(360);
  });

  it("resets a detached log for a new job in the same phase", () => {
    const view = renderOverlay(makeJob(makeLines(1, 30)));
    const geometry = configureLogGeometry(900, 180);
    flushAnimationFrames();
    const log = screen.getByLabelText("설치 로그");

    fireEvent.wheel(log, { deltaY: -120 });
    geometry.scrollTop = 300;
    fireEvent.scroll(log);
    geometry.scrollHeight = 1_060;
    rerenderOverlay(view, makeJob(makeLines(31, 60), "job-2"));

    expect(geometry.scrollTop).toBe(880);
  });
});

class ResizeObserverMock {
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  observe(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }
}

type LogGeometry = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

function configureLogGeometry(
  scrollHeight: number,
  clientHeight: number,
): LogGeometry {
  const element = screen.getByLabelText("설치 로그") as HTMLDivElement;
  const geometry = { clientHeight, scrollHeight, scrollTop: 0 };
  Object.defineProperties(element, {
    clientHeight: { configurable: true, get: () => geometry.clientHeight },
    scrollHeight: { configurable: true, get: () => geometry.scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => geometry.scrollTop,
      set: (value: number) => {
        geometry.scrollTop = Math.max(
          0,
          Math.min(value, geometry.scrollHeight - geometry.clientHeight),
        );
      },
    },
  });
  element.scrollTop = element.scrollHeight;
  return geometry;
}

function flushAnimationFrames(): void {
  act(() => {
    while (queuedFrames.size > 0) {
      const frames = [...queuedFrames.values()];
      queuedFrames.clear();
      frames.forEach((callback) => callback(performance.now()));
    }
  });
}

function notifyContentResize(): void {
  const observer = resizeObservers[resizeObservers.length - 1];
  if (!observer) {
    throw new Error("Expected the install log content to be observed.");
  }
  act(() => observer.callback([], observer as unknown as ResizeObserver));
}

function renderOverlay(job: JobState): RenderResult {
  return render(<InstallProgressOverlay job={job} snapshot={null} />);
}

function rerenderOverlay(view: RenderResult, job: JobState): void {
  view.rerender(<InstallProgressOverlay job={job} snapshot={null} />);
}

function makeJob(installLogLines: string[], id = "job-1"): JobState {
  return {
    id,
    installLogLines,
    kind: "gemma-analysis",
    phase: "model_downloading",
    progressText: "모델 다운로드 중",
    status: "running",
  };
}

function makeLines(first: number, last: number): string[] {
  return Array.from(
    { length: last - first + 1 },
    (_, index) => `log line ${first + index}`,
  );
}

function longLine(): string {
  return `very long download path ${"nested-directory/".repeat(60)}model.gguf`;
}
