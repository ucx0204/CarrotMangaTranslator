// @vitest-environment jsdom

import React, { useEffect, useRef, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEvent, JobState } from "../src/shared/jobTypes";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { useJobEvents } from "../src/renderer/src/hooks/useJobEvents";
import {
  createAggregateJobEventGuard,
  shouldIgnoreAggregateJobEvent,
} from "../src/renderer/src/hooks/jobEventFlowGuard";
import { useAppSessionLifecycleEffects } from "../src/renderer/src/app/session/useAppSessionLifecycleEffects";
import { toast } from "../src/renderer/src/lib/toastStore";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("job event render scheduling", () => {
  it("blocks late child progress after an inpainting aggregate terminates but admits a new start", () => {
    const current: JobState = {
      id: "inpainting-flow-failed",
      kind: "inpainting",
      progressText: "aggregate failed",
      status: "failed",
    };
    const guard = createAggregateJobEventGuard();
    guard.activeJobIds.add("owned-child");

    expect(
      shouldIgnoreAggregateJobEvent(
        current,
        { ...makeStateEvent("running"), id: "owned-child" },
        guard,
        false,
      ),
    ).toBe(true);
    guard.activeJobIds.clear();

    expect(
      shouldIgnoreAggregateJobEvent(
        current,
        { ...makeStateEvent("running"), id: "late-child" },
        guard,
        false,
      ),
    ).toBe(true);
    expect(
      shouldIgnoreAggregateJobEvent(
        current,
        { ...makeStateEvent("starting"), id: "new-job" },
        guard,
        false,
      ),
    ).toBe(false);
  });

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

  it("does not regress a terminal job from a queued nonterminal event", () => {
    const frames = installAnimationFrameController();
    let emit: ((event: JobEvent) => void) | null = null;
    const api = React.createRef<JobHarnessApi>();
    render(
      <JobHarness
        onReady={(value) => {
          api.current = value;
        }}
        subscribeJobEvents={(listener) => {
          emit = listener;
          return () => undefined;
        }}
      />,
    );

    act(() => {
      emit?.(makeStateEvent("cancelled"));
      frames.flush();
    });
    expect(api.current?.getJobState().status).toBe("cancelled");

    act(() => {
      emit?.(makeStateEvent("cancelling"));
      frames.flush();
    });
    expect(api.current?.getJobState().status).toBe("cancelled");
  });

  it("suppresses child terminal events while an aggregate flow is active", () => {
    const frames = installAnimationFrameController();
    let emit: ((event: JobEvent) => void) | null = null;
    const api = React.createRef<JobHarnessApi>();
    render(
      <JobHarness
        suppressTerminalEvents
        onReady={(value) => {
          api.current = value;
        }}
        subscribeJobEvents={(listener) => {
          emit = listener;
          return () => undefined;
        }}
      />,
    );

    act(() => {
      emit?.(makeStateEvent("running"));
      emit?.(makeStateEvent("completed"));
      frames.flush();
    });

    expect(api.current?.getJobState().status).toBe("running");
  });

  it("does not let a late child terminal overwrite an aggregate flow terminal", () => {
    const frames = installAnimationFrameController();
    let emit: ((event: JobEvent) => void) | null = null;
    const api = React.createRef<JobHarnessApi>();
    render(
      <JobHarness
        initialJobState={{
          id: "translation-flow-failed",
          kind: "gemma-analysis",
          progressText: "전체 실패",
          status: "failed",
        }}
        onReady={(value) => {
          api.current = value;
        }}
        subscribeJobEvents={(listener) => {
          emit = listener;
          return () => undefined;
        }}
      />,
    );

    act(() => {
      emit?.({ ...makeStateEvent("completed"), id: "late-child" });
      frames.flush();
    });
    expect(api.current?.getJobState()).toMatchObject({
      id: "translation-flow-failed",
      status: "failed",
    });

    act(() => {
      emit?.({ ...makeStateEvent("running"), id: "new-job" });
      frames.flush();
    });
    expect(api.current?.getJobState()).toMatchObject({
      id: "new-job",
      status: "running",
    });
  });

  it("ignores late progress and terminal events from an inpainting flow child", () => {
    const frames = installAnimationFrameController();
    let emit: ((event: JobEvent) => void) | null = null;
    const api = React.createRef<JobHarnessApi>();
    const onReady = (value: JobHarnessApi): void => {
      api.current = value;
    };
    const subscribeJobEvents = (listener: (event: JobEvent) => void) => {
      emit = listener;
      return () => undefined;
    };
    const view = render(
      <JobHarness
        suppressTerminalEvents
        onReady={onReady}
        subscribeJobEvents={subscribeJobEvents}
      />,
    );

    act(() => {
      emit?.({ ...makeStateEvent("running"), id: "inpainting-child" });
      frames.flush();
      api.current?.setJobState({
        id: "inpainting-flow-failed",
        kind: "inpainting",
        progressText: "aggregate failed",
        status: "failed",
      });
    });
    view.rerender(
      <JobHarness onReady={onReady} subscribeJobEvents={subscribeJobEvents} />,
    );

    act(() => {
      emit?.({ ...makeStateEvent("running"), id: "inpainting-child" });
      emit?.({ ...makeStateEvent("completed"), id: "inpainting-child" });
      emit?.({ ...makeStateEvent("running"), id: "unseen-late-child" });
      frames.flush();
    });

    expect(api.current?.getJobState()).toMatchObject({
      id: "inpainting-flow-failed",
      status: "failed",
    });

    act(() => {
      emit?.({ ...makeStateEvent("starting"), id: "new-job" });
      frames.flush();
    });
    expect(api.current?.getJobState()).toMatchObject({
      id: "new-job",
      status: "starting",
    });
  });

  it("emits one success notification for the final aggregate only", () => {
    const frames = installAnimationFrameController();
    const success = vi.spyOn(toast, "success").mockReturnValue("toast-id");
    let emit: ((event: JobEvent) => void) | null = null;
    const api = React.createRef<JobHarnessApi>();
    const onReady = (value: JobHarnessApi): void => {
      api.current = value;
    };
    const subscribeJobEvents = (listener: (event: JobEvent) => void) => {
      emit = listener;
      return () => undefined;
    };
    const view = render(
      <AggregateLifecycleHarness
        flowActive
        onReady={onReady}
        subscribeJobEvents={subscribeJobEvents}
      />,
    );

    act(() => {
      emit?.({ ...makeStateEvent("running"), id: "inpainting-child" });
      emit?.({ ...makeStateEvent("completed"), id: "inpainting-child" });
      frames.flush();
    });
    expect(success).not.toHaveBeenCalled();
    expect(api.current?.getJobState().status).toBe("running");

    act(() => {
      api.current?.setJobState({
        id: "inpainting-flow-completed",
        kind: "inpainting",
        progressText: "all chapters completed",
        status: "completed",
      });
    });
    expect(success).not.toHaveBeenCalled();

    act(() => {
      view.rerender(
        <AggregateLifecycleHarness
          flowActive={false}
          onReady={onReady}
          subscribeJobEvents={subscribeJobEvents}
        />,
      );
    });

    expect(success).toHaveBeenCalledOnce();
    expect(success).toHaveBeenCalledWith(expect.any(String));
  });

  it("forwards a runtime calibration notification immediately", () => {
    const frames = installAnimationFrameController();
    const info = vi.spyOn(toast, "info").mockReturnValue("toast-id");
    let emit: ((event: JobEvent) => void) | null = null;
    render(
      <JobHarness
        onReady={() => undefined}
        subscribeJobEvents={(listener) => {
          emit = listener;
          return () => undefined;
        }}
      />,
    );

    act(() => {
      emit?.({
        ...makeStateEvent("running"),
        notification: {
          variant: "info",
          message: "MTP fit 여유 VRAM을 실행 중에만 512 MiB 보정했습니다.",
        },
      });
    });

    expect(info).toHaveBeenCalledWith(
      "MTP fit 여유 VRAM을 실행 중에만 512 MiB 보정했습니다.",
    );
    act(() => frames.flush());
  });

  it("attributes a status line when every target belongs to one chapter", () => {
    const frames = installAnimationFrameController();
    const appendStatusLine = vi.fn();
    let emit: ((event: JobEvent) => void) | null = null;
    render(
      <JobHarness
        appendStatusLine={appendStatusLine}
        onReady={() => undefined}
        subscribeJobEvents={(listener) => {
          emit = listener;
          return () => undefined;
        }}
      />,
    );

    act(() => {
      emit?.({
        ...makeStateEvent("running"),
        targets: [
          {
            chapterId: "chapter-1",
            pageId: "page-1",
            revision: "page-v1:one",
          },
          {
            chapterId: "chapter-1",
            pageId: "page-2",
            revision: "page-v1:two",
          },
        ],
      });
      frames.flush();
    });

    expect(appendStatusLine.mock.calls.at(-1)?.[2]).toBe("chapter-1");
  });
});

type JobHarnessApi = {
  getJobState: () => JobState;
  getRenderCount: () => number;
  setJobState: React.Dispatch<React.SetStateAction<JobState>>;
};

const ignoreStatusLine = (): void => undefined;
const ignoreChapter = (): void => undefined;

function JobHarness({
  appendStatusLine = ignoreStatusLine,
  initialJobState,
  onReady,
  suppressTerminalEvents = false,
  subscribeJobEvents,
}: {
  appendStatusLine?: (
    line: string,
    replace?: (line: string) => boolean,
    chapterId?: string,
  ) => void;
  initialJobState?: JobState;
  onReady: (api: JobHarnessApi) => void;
  suppressTerminalEvents?: boolean;
  subscribeJobEvents: (listener: (event: JobEvent) => void) => () => void;
}): React.JSX.Element {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const currentChapterRef = useRef<ChapterSnapshot | null>(null);
  const [jobState, setJobState] = useState<JobState>(
    initialJobState ?? {
      id: "",
      kind: "gemma-analysis",
      progressText: "",
      status: "idle",
    },
  );
  useJobEvents({
    appendStatusLine,
    currentChapterRef,
    jobState,
    mergeLiveChapter: ignoreChapter,
    setJobState,
    suppressTerminalEvents,
    subscribeJobEvents,
  });
  useEffect(() => {
    onReady({
      getJobState: () => jobState,
      getRenderCount: () => renderCountRef.current,
      setJobState,
    });
  }, [jobState, onReady]);
  return <div data-job-status={jobState.status} />;
}

function AggregateLifecycleHarness({
  flowActive,
  onReady,
  subscribeJobEvents,
}: {
  flowActive: boolean;
  onReady: (api: JobHarnessApi) => void;
  subscribeJobEvents: (listener: (event: JobEvent) => void) => () => void;
}): React.JSX.Element {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const currentChapterRef = useRef<ChapterSnapshot | null>(null);
  const [jobState, setJobState] = useState<JobState>({
    id: "idle",
    kind: "inpainting",
    progressText: "",
    status: "idle",
  });
  useJobEvents({
    appendStatusLine: ignoreStatusLine,
    currentChapterRef,
    jobState,
    mergeLiveChapter: ignoreChapter,
    setJobState,
    suppressTerminalEvents: flowActive,
    subscribeJobEvents,
  });
  useAppSessionLifecycleEffects({
    currentChapter: null,
    jobState,
    onJobStart: () => undefined,
    onPageChange: () => undefined,
    openErrorReport: () => undefined,
    refreshLibrary: () => undefined,
    resetChapterScopedUi: () => undefined,
    selectedPageId: null,
    setRegionSelection: () => undefined,
    translationFlowActive: flowActive,
  });
  useEffect(() => {
    onReady({
      getJobState: () => jobState,
      getRenderCount: () => renderCountRef.current,
      setJobState,
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

function makeStateEvent(status: JobEvent["status"]): JobEvent {
  return {
    id: "job-1",
    kind: "gemma-analysis",
    progressText: status,
    status,
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
