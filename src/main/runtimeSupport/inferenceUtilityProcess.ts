import { utilityProcess, type UtilityProcess } from "electron";
import {
  assertModelCleanupComplete,
  releaseModelResource,
} from "./modelCleanupBarrier";

type Child = {
  process: UtilityProcess;
  stopping: boolean;
  ended: boolean;
  spawned: Promise<void>;
  exited: Promise<number>;
};
type Reply<T> = { ok: true; result: T } | { ok: false; error: string };

/** Native ORT schedules synchronous work on its calling thread. Own one
 * process per model lifetime and admit one request at a time to that process. */
export class InferenceUtilityProcess<Input, Output> {
  private child?: Child;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly script: string,
    private readonly name: string,
    private readonly logPath?: () => string,
  ) {}

  run(input: Input, signal?: AbortSignal): Promise<Output> {
    return new Promise<Output>((resolve, reject) => {
      const cancelQueued = () =>
        reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) {
        cancelQueued();
        return;
      }
      signal?.addEventListener("abort", cancelQueued, { once: true });
      const pending = this.enqueue(async () => {
        signal?.removeEventListener("abort", cancelQueued);
        signal?.throwIfAborted();
        assertModelCleanupComplete();
        const child = this.child ?? this.start();
        try {
          return await this.request(child.process, input, signal);
        } finally {
          // A synchronous native call cannot receive cancellation messages.
          if (signal?.aborted) await this.stop(child);
        }
      });
      void pending.then(resolve, reject);
    });
  }

  private request(proc: UtilityProcess, input: Input, signal?: AbortSignal) {
    return new Promise<Output>((resolve, reject) => {
      const cleanup = () => {
        proc.off("message", onReply);
        proc.off("exit", onExit);
        signal?.removeEventListener("abort", onAbort);
      };
      const onReply = (reply: Reply<Output>) => {
        cleanup();
        if (reply.ok) resolve(reply.result);
        else reject(new Error(reply.error));
      };
      const onExit = (code: number) => {
        cleanup();
        reject(new Error(`${this.name} exited (${code})`));
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };
      proc.once("message", onReply);
      proc.once("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        proc.postMessage(input);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  dispose(): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.child) return false;
      await this.stop(this.child);
      return true;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = Promise.allSettled([pending]);
    return pending;
  }

  private start(): Child {
    const proc = utilityProcess.fork(this.script, [], {
      serviceName: this.name,
      ...(this.logPath && {
        env: { ...process.env, MANGA_TRANSLATOR_LOG_PATH: this.logPath() },
      }),
    });
    const child: Child = {
      process: proc,
      stopping: false,
      ended: false,
      spawned: new Promise<void>((resolve) => proc.once("spawn", resolve)),
      exited: new Promise<number>((resolve) => {
        proc.once("exit", (code) => {
          child.ended = true;
          if (!child.stopping && this.child === child) this.child = undefined;
          resolve(code);
        });
      }),
    };
    this.child = child;
    return child;
  }

  private stop(child: Child): Promise<void> {
    child.stopping = true;
    return releaseModelResource(child, async () => {
      if (child.process.pid === undefined)
        await Promise.race([child.spawned, child.exited]);
      if (!child.ended && !child.process.kill())
        throw new Error(`Could not terminate ${this.name}.`);
      await child.exited;
      if (this.child === child) this.child = undefined;
    });
  }
}
