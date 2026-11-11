// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppActivityGate } from "../src/main/appActivityGate";
import { AppOperationRegistry } from "../src/main/appOperationRegistry";
import { registerAppOperationIpc } from "../src/main/ipc/appOperationIpc";
import { ActiveJobStore } from "../src/main/jobs/activeJob";
import {
  acquireJobPageOwnership,
  releaseJobPage,
} from "../src/main/jobs/jobPageOwnership";
import { libraryMutationCoordinator } from "../src/main/libraryStore/libraryMutationCoordinator";
import { withLibraryContentEdit } from "../src/main/library/lock";
import { pageContentResource } from "../src/shared/appActivityTypes";
import {
  executePageWorkflow,
  type PageWorkflowExecutionPort,
} from "../src/main/application/pageWorkflowService";
import { createMangaApi } from "../src/preload/mangaApi";
import { createContractInvoker } from "../src/preload/ipcContracts";
import { useAppActivities } from "../src/renderer/src/hooks/useAppActivities";
import {
  usePageEditHandoff,
  usePageInputActivity,
} from "../src/renderer/src/hooks/usePageEditHandoff";
import { pendingPageEdits } from "../src/renderer/src/lib/pageEditBarrier";
import { createPageWorkflowPlan } from "../src/shared/pageWorkflowTypes";
import { makeChapter, makePage } from "./helpers/workspacePointerFixtures";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const boundary = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));
vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: Handler) =>
      boundary.handlers.set(channel, handler),
  },
}));

afterEach(() => {
  cleanup();
  libraryMutationCoordinator.configureActivityGate(null);
  boundary.handlers.clear();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function harness(count = 1) {
  vi.stubEnv(
    "MANGA_TRANSLATOR_LOG_PATH",
    ".tmp/page-workflow-handoff-test.log",
  );
  const gate = new AppActivityGate();
  const jobs = new ActiveJobStore({ error: vi.fn(), info: vi.fn() }, gate);
  libraryMutationCoordinator.configureActivityGate(gate);
  const listeners = new Map<
    string,
    Set<(event: unknown, payload: unknown) => void>
  >();
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "http://127.0.0.1:5173/" },
  };
  let paused = false;
  let delayed: { channel: string; payload: unknown } | undefined;
  const deliver = (channel: string, payload: unknown) => {
    if (paused) {
      delayed = { channel, payload };
      return;
    }
    for (const listener of listeners.get(channel) ?? []) listener({}, payload);
  };
  const mainWindow = {
    isDestroyed: () => false,
    webContents: {
      id: 1,
      getURL: () => event.senderFrame.url,
      send: deliver,
    },
  };
  registerAppOperationIpc({
    jobs,
    operations: new AppOperationRegistry(gate),
    getMainWindow: () => mainWindow as never,
  });
  window.mangaApi = createMangaApi({
    invoke: createContractInvoker({
      invoke: async (channel, ...args) => {
        const handler = boundary.handlers.get(channel);
        if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
        return handler(event, ...args);
      },
    }),
    events: {
      on: (channel, listener) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)?.add(listener);
      },
      removeListener: (channel, listener) => {
        listeners.get(channel)?.delete(listener);
      },
    },
    getPathForFile: () => "",
    warn: (message) => {
      throw new Error(message);
    },
  });
  let chapter = makeChapter(makePage());
  chapter.pages = Array.from({ length: count }, (_, index) => ({
    ...makePage(),
    id: `page-${index + 1}`,
  }));
  chapter.pageOrder = chapter.pages.map((page) => page.id);
  const saved = vi.fn(async () => {});
  const view = renderHook(() => {
    const state = useAppActivities();
    usePageInputActivity(chapter.id, chapter.pages[0].id, state);
    usePageEditHandoff(state, saved);
    return state;
  });
  const abort = new AbortController();
  const execute = vi.fn<PageWorkflowExecutionPort["execute"]>(
    async (_stage, _chapter, page) => ({
      ...page,
      blocks: page.blocks.map((block) => ({
        ...block,
        translatedText: "번역 완료",
      })),
    }),
  );
  const start = () => {
    jobs.start({
      id: "translation",
      kind: "gemma-analysis",
      resources: [],
      abortController: abort,
    });
    jobs.pageHandoffs.reserve("translation", chapter.id, chapter.pageOrder);
    return jobs.run("translation", () =>
      executePageWorkflow(
        {
          runId: "translation",
          plan: createPageWorkflowPlan(["translate"]),
          selection: [{ chapterId: chapter.id, pageIds: chapter.pageOrder }],
          signal: abort.signal,
        },
        {
          readChapter: async () => structuredClone(chapter),
          acquirePage: (chapterId, pageId) =>
            acquireJobPageOwnership(jobs, "translation", chapterId, pageId),
          releasePage: (chapterId, pageId) =>
            releaseJobPage(jobs, "translation", chapterId, pageId),
          prepareStage: async () => {},
          execute,
          save: async (_chapterId, before, after) => {
            chapter = {
              ...chapter,
              pages: chapter.pages.map((page) =>
                page.id === before.id ? after : page,
              ),
            };
          },
          progress: () => {},
          isFatal: () => true,
        },
      ),
    );
  };
  return {
    jobs,
    view,
    start,
    abort,
    execute,
    saved,
    chapterId: chapter.id,
    pauseDelivery: () => {
      paused = true;
    },
    resumeDelivery: () => {
      paused = false;
      if (delayed) deliver(delayed.channel, delayed.payload);
      delayed = undefined;
    },
  };
}

it("waits for native image writes after the renderer acknowledges before starting translation", async () => {
  const h = harness();
  let finishWrite!: () => void;
  const nativeWrite = withLibraryContentEdit(
    [pageContentResource(h.chapterId, "page-1")],
    () =>
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
  );
  let result: Awaited<ReturnType<typeof h.start>> | undefined;
  act(() => {
    void h.start().then((value) => {
      result = value;
    });
  });
  try {
    await waitFor(() => expect(h.saved).toHaveBeenCalledOnce());
    expect(h.execute).not.toHaveBeenCalled();
    expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(1);
    await act(async () => {
      finishWrite();
      await nativeWrite;
    });
    await waitFor(() => expect(result?.status).toBe("completed"));
    expect(h.execute).toHaveBeenCalledOnce();
    expect(libraryMutationCoordinator.getActiveCountForTests()).toBe(0);
  } finally {
    finishWrite();
    await nativeWrite;
    h.abort.abort();
  }
});

it("recovers when a stalled renderer first receives the already timed-out request", async () => {
  vi.useFakeTimers();
  const h = harness();
  let result: Awaited<ReturnType<typeof h.start>> | undefined;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  h.pauseDelivery();
  act(() => {
    void h.start().then((value) => {
      result = value;
    });
  });
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15001);
    });
    expect(h.jobs.pageHandoffs.activities[0].phase).toBe("waiting");
    expect(h.saved).not.toHaveBeenCalled();
    act(() => h.resumeDelivery());
    for (let step = 0; step < 10 && !result; step++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
    }
    expect(result?.status).toBe("completed");
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.saved).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      h.abort.abort();
      await vi.advanceTimersByTimeAsync(1);
    });
  }
});

it("passes all 183 page handoffs through the real preload contracts and activity IPC before translation", async () => {
  const h = harness(183);
  let result: Awaited<ReturnType<typeof h.start>> | undefined;
  act(() => {
    void h.start().then((value) => {
      result = value;
    });
  });
  try {
    await waitFor(() => expect(result?.status).toBe("completed"), {
      timeout: 12000,
    });
    expect(h.saved).toHaveBeenCalledTimes(183);
    expect(h.execute).toHaveBeenCalledTimes(183);
    expect(
      result?.chapters[0].pages.every(
        (page) => page.blocks[0].translatedText === "번역 완료",
      ),
    ).toBe(true);
  } finally {
    h.abort.abort();
  }
});

it.each([false, true])(
  "recovers a timed-out handoff and rechecks newer edits (new edit: %s)",
  async (newEdit) => {
    vi.useFakeTimers();
    const h = harness();
    const finishEdit = pendingPageEdits.begin(h.chapterId, "page-1");
    let finishNewEdit: (() => void) | undefined;
    if (newEdit)
      h.saved.mockImplementationOnce(async () => {
        finishNewEdit = pendingPageEdits.begin(h.chapterId, "page-1");
      });
    let result: Awaited<ReturnType<typeof h.start>> | undefined;
    act(() => {
      void h.start().then((value) => {
        result = value;
      });
    });
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(h.view.result.current?.pages[0]).toMatchObject({
        phase: "waiting",
        reason:
          "편집 저장 응답을 기다리고 있습니다. 저장 상태를 확인하고 다시 시도해 주세요.",
      });
      expect(h.execute).not.toHaveBeenCalled();
      const expiredRequest = h.view.result.current?.pages[0].requestId;
      act(() => finishEdit());
      for (let step = 0; step < 10 && !result; step++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
      }
      if (newEdit) {
        expect(h.view.result.current?.pages[0].requestId).not.toBe(
          expiredRequest,
        );
        expect(h.execute).not.toHaveBeenCalled();
        act(() => finishNewEdit?.());
        for (let step = 0; step < 10 && !result; step++) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
          });
        }
      }
      expect(result?.status).toBe("completed");
      expect(h.execute).toHaveBeenCalledOnce();
    } finally {
      finishEdit();
      finishNewEdit?.();
      await act(async () => {
        h.abort.abort();
        await vi.advanceTimersByTimeAsync(1);
      });
    }
  },
);

it("shows a late disk failure and requires manual retry instead of looping", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.saved.mockRejectedValueOnce(new Error("disk full"));
  const finishEdit = pendingPageEdits.begin(h.chapterId, "page-1");
  let result: Awaited<ReturnType<typeof h.start>> | undefined;
  act(() => {
    void h.start().then((value) => {
      result = value;
    });
  });
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    act(() => finishEdit());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(h.view.result.current?.pages[0]).toMatchObject({
      phase: "waiting",
      reason: "disk full",
    });
    expect(h.saved).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
    const requestId = h.view.result.current?.pages[0].requestId;
    if (!requestId) throw new Error("Missing waiting request");
    await act(async () => {
      await window.mangaApi.retryPageEditHandoff(requestId);
    });
    for (let step = 0; step < 10 && !result; step++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
    }
    expect(result?.status).toBe("completed");
  } finally {
    finishEdit();
    await act(async () => {
      h.abort.abort();
      await vi.advanceTimersByTimeAsync(1);
    });
  }
});

it("does not restart a cancelled translation when a late save finishes", async () => {
  vi.useFakeTimers();
  const h = harness();
  const finishEdit = pendingPageEdits.begin(h.chapterId, "page-1");
  let result: Awaited<ReturnType<typeof h.start>> | undefined;
  act(() => {
    void h.start().then((value) => {
      result = value;
    });
  });
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    await act(async () => {
      h.abort.abort();
      await vi.advanceTimersByTimeAsync(1);
    });
    act(() => finishEdit());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result?.status).toBe("cancelled");
    expect(h.execute).not.toHaveBeenCalled();
    expect(
      h.jobs.pageHandoffs.respond({
        requestId: h.view.result.current?.pages[0].requestId ?? "missing",
      }),
    ).toBe(false);
  } finally {
    finishEdit();
    h.abort.abort();
  }
});
