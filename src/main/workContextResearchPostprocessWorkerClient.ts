import { Worker } from "node:worker_threads";
import type {
  WorkContextResearchPostprocessInput,
  WorkContextResearchPostprocessRequest,
  WorkContextResearchPostprocessResponse,
} from "./workContextResearchPostprocess";
import type { NormalizedResearchChanges } from "./workContextResearchNormalize";

export type ResearchPostprocessWorker = {
  on(
    event: "message",
    listener: (message: WorkContextResearchPostprocessResponse) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  off(
    event: "message",
    listener: (message: WorkContextResearchPostprocessResponse) => void,
  ): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  off(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: WorkContextResearchPostprocessRequest): void;
  terminate(): Promise<number>;
};

export type ResearchPostprocessWorkerFactory = () => ResearchPostprocessWorker;

export async function postprocessWorkContextResearchInWorker(
  input: WorkContextResearchPostprocessInput,
  signal?: AbortSignal,
  createWorker: ResearchPostprocessWorkerFactory = createResearchPostprocessWorker,
): Promise<NormalizedResearchChanges> {
  signal?.throwIfAborted();
  const worker = createWorker();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (
      action: "resolve" | "reject",
      value: NormalizedResearchChanges | Error,
    ): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      void worker.terminate().then(
        () => undefined,
        (_terminateError) => {
          /* error-policy-allow: the result already settled, so a concurrent worker termination failure is non-actionable */
        },
      );
      if (action === "resolve") resolve(value as NormalizedResearchChanges);
      else reject(value);
    };
    const onMessage = (
      message: WorkContextResearchPostprocessResponse,
    ): void => {
      if (message.type === "postprocess-done") {
        settle("resolve", message.result);
        return;
      }
      const error = new Error(message.error.message);
      error.name = message.error.name;
      settle("reject", error);
    };
    const onError = (error: Error): void => settle("reject", error);
    const onExit = (code: number): void =>
      settle(
        "reject",
        new Error(`인터넷 조사 후처리 워커가 종료되었습니다. (code ${code})`),
      );
    const onAbort = (): void => {
      const reason = signal?.reason;
      settle(
        "reject",
        reason instanceof Error
          ? reason
          : new DOMException("Aborted", "AbortError"),
      );
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      worker.postMessage({ type: "postprocess", input });
    } catch (error) {
      onError(
        error instanceof Error
          ? error
          : new Error("인터넷 조사 후처리 워커를 시작하지 못했습니다."),
      );
    }
  });
}

function createResearchPostprocessWorker(): ResearchPostprocessWorker {
  return new Worker(
    require.resolve("./workContextResearchPostprocessWorker.js"),
  );
}
