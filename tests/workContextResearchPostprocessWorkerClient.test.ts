import { describe, expect, it, vi } from "vitest";
import type {
  WorkContextResearchPostprocessRequest,
  WorkContextResearchPostprocessResponse,
} from "../src/main/workContextResearchPostprocess";
import {
  postprocessWorkContextResearchInWorker,
  type ResearchPostprocessWorker,
} from "../src/main/workContextResearchPostprocessWorkerClient";

type WorkerEvent = "message" | "error" | "exit";
type MessageListener = (
  message: WorkContextResearchPostprocessResponse,
) => void;
type ErrorListener = (error: Error) => void;
type ExitListener = (code: number) => void;
type WorkerListener = MessageListener | ErrorListener | ExitListener;

describe("work-context research postprocess worker client", () => {
  it("resolves a completed result and terminates the worker", async () => {
    const fake = createFakeWorker();
    const result = {
      operations: [],
      warnings: ["검증 완료"],
      estimatedTokenDelta: 0,
    };
    fake.postMessage.mockImplementation(() => {
      queueMicrotask(() =>
        fake.emit("message", {
          type: "postprocess-done",
          result,
        } satisfies WorkContextResearchPostprocessResponse),
      );
    });

    await expect(
      postprocessWorkContextResearchInWorker(
        makeInput(),
        undefined,
        () => fake.worker,
      ),
    ).resolves.toEqual(result);
    expect(fake.postMessage).toHaveBeenCalledOnce();
    expect(fake.terminate).toHaveBeenCalledOnce();
  });

  it("rejects even when a worker exits cleanly before returning a result", async () => {
    const fake = createFakeWorker();
    fake.postMessage.mockImplementation(() => {
      queueMicrotask(() => fake.emit("exit", 0));
    });

    await expect(
      postprocessWorkContextResearchInWorker(
        makeInput(),
        undefined,
        () => fake.worker,
      ),
    ).rejects.toThrow("code 0");
    expect(fake.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the worker when research is cancelled", async () => {
    const fake = createFakeWorker();
    const controller = new AbortController();
    const running = postprocessWorkContextResearchInWorker(
      makeInput(),
      controller.signal,
      () => fake.worker,
    );

    controller.abort(new DOMException("조사가 취소되었습니다.", "AbortError"));

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.terminate).toHaveBeenCalledOnce();
  });
});

function createFakeWorker(): {
  worker: ResearchPostprocessWorker;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  emit: (event: WorkerEvent, value: unknown) => void;
} {
  const worker = new FakeResearchPostprocessWorker();
  return {
    worker,
    postMessage: worker.postMessage,
    terminate: worker.terminate,
    emit: (event, value) => worker.emit(event, value),
  };
}

class FakeResearchPostprocessWorker implements ResearchPostprocessWorker {
  private readonly listeners = new Map<WorkerEvent, Set<WorkerListener>>();
  readonly postMessage =
    vi.fn<(message: WorkContextResearchPostprocessRequest) => void>();
  readonly terminate = vi.fn(async () => 0);

  on(event: "message", listener: MessageListener): unknown;
  on(event: "error", listener: ErrorListener): unknown;
  on(event: "exit", listener: ExitListener): unknown;
  on(event: WorkerEvent, listener: WorkerListener): unknown {
    const registered = this.listeners.get(event) ?? new Set<WorkerListener>();
    registered.add(listener);
    this.listeners.set(event, registered);
    return this;
  }

  off(event: "message", listener: MessageListener): unknown;
  off(event: "error", listener: ErrorListener): unknown;
  off(event: "exit", listener: ExitListener): unknown;
  off(event: WorkerEvent, listener: WorkerListener): unknown {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: WorkerEvent, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (payload: unknown) => void)(value);
    }
  }
}

function makeInput() {
  return {
    raw: { operations: [], warnings: [] },
    promptInput: {
      workTitle: "테스트 작품",
      guide: {
        schemaVersion: 1 as const,
        workId: "work-1",
        glossary: [],
        characters: [],
        rules: {
          honorifics: "preserve" as const,
          sfxMode: "translate" as const,
          defaultTone: "natural_korean" as const,
        },
        createdAt: "2026-08-29T00:00:00.000Z",
        updatedAt: "2026-08-29T00:00:00.000Z",
      },
      selection: {
        text: "",
        basePages: [],
        coverage: {
          scope: "work" as const,
          workId: "work-1",
          requestedChapterId: "chapter-1",
          totalChapters: 1,
          includedChapters: 0,
          totalPages: 0,
          includedPages: 0,
          selectedChars: 0,
          maxInputChars: 65_536,
          truncated: false,
        },
      },
    },
    usage: { workId: "work-1", glossary: [], characters: [] },
  };
}
