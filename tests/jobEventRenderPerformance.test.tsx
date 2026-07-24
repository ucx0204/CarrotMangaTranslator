// @vitest-environment jsdom

import React, { useEffect, useRef, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEvent, JobState } from "../src/shared/jobTypes";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { useJobEvents } from "../src/renderer/src/hooks/useJobEvents";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("job event render scheduling", () => {
  it("reduces a log burst in one low-priority animation frame", () => {
    const frames = installAnimationFrameController();
    let emit: ((event: JobEvent) => void) | null = null;
    const unsubscribe = vi.fn();
    const subscribeJobEvents = (listener: (event: JobEvent) => void) => {
      emit = listener;
      return unsubscribe;
    };
    const api = React.createRef<JobHarnessApi>();
    const view = render(
      <JobHarness
        onReady={(value) => {
          api.current = value;
        }}
        subscribeJobEvents={subscribeJobEvents}
      />,
    );
    const renderCount = api.current?.getRenderCount();

    act(() => {
      for (let index = 0; index < 120; index += 1) {
        emit?.(makeLogEvent(index));
      }
    });

    expect(api.current?.getRenderCount()).toBe(renderCount);
    expect(frames.count()).toBe(1);
    act(() => frames.flush());

    expect(api.current?.getRenderCount()).toBe((renderCount ?? 0) + 1);
    expect(api.current?.getJobState().installLogLines).toHaveLength(80);
    expect(api.current?.getJobState().installLogLines?.at(-1)).toBe("line-119");

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

type JobHarnessApi = {
  getJobState: () => JobState;
  getRenderCount: () => number;
};

const ignoreStatusLine = (): void => undefined;
const ignoreChapter = (): void => undefined;

function JobHarness({
  onReady,
  subscribeJobEvents,
}: {
  onReady: (api: JobHarnessApi) => void;
  subscribeJobEvents: (listener: (event: JobEvent) => void) => () => void;
}): React.JSX.Element {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const currentChapterRef = useRef<ChapterSnapshot | null>(null);
  const [jobState, setJobState] = useState<JobState>({
    id: "",
    kind: "gemma-analysis",
    progressText: "",
    status: "idle",
  });
  useJobEvents({
    appendStatusLine: ignoreStatusLine,
    currentChapterRef,
    mergeLiveChapter: ignoreChapter,
    setJobState,
    subscribeJobEvents,
  });
  useEffect(() => {
    onReady({
      getJobState: () => jobState,
      getRenderCount: () => renderCountRef.current,
    });
  }, [jobState, onReady]);
  return <div data-job-status={jobState.status} />;
}

function makeLogEvent(index: number): JobEvent {
  return {
    id: "job-1",
    installLogLine: `line-${index}`,
    kind: "gemma-analysis",
    progressMode: "log-only",
    progressText: "running",
    status: "running",
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
