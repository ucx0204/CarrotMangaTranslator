import { AsyncLocalStorage } from "node:async_hooks";
import { releaseModelResource } from "./modelCleanupBarrier";

type Kind = "translation" | "inpainting";
type Lease<T> = { value: T; release: () => Promise<void> };
type Entry = { value: unknown; release: () => Promise<void> };
const current = new AsyncLocalStorage<ModelWorkload>();

/** Native composition only. No serialized job or caller-supplied owner can create this scope. */
class ModelWorkload {
  private entry?: Promise<Entry>;
  private identity?: string;
  private borrowed = false;
  private closed = false;
  private returned: Promise<void> = Promise.resolve();
  private returnLease: () => void = () => {};
  constructor(readonly kind: Kind, readonly signal: AbortSignal) {}

  async acquire<T>(identity: string, create: (signal: AbortSignal) => Promise<Lease<T>>): Promise<Lease<T>> {
    this.signal.throwIfAborted();
    if (this.closed || this.borrowed)
      throw new Error("A model workload is closed or already has an active native borrower.");
    if (this.identity !== undefined && this.identity !== identity)
      throw new Error("A model workload cannot silently switch resource configuration.");
    this.identity = identity;
    this.borrowed = true;
    this.returned = new Promise<void>((resolve) => { this.returnLease = resolve; });
    this.entry ??= create(this.signal);
    try {
      const entry = await this.entry;
      this.signal.throwIfAborted();
      let released = false;
      return {
        value: entry.value as T,
        release: async () => {
          if (released) return;
          released = true;
          this.borrowed = false;
          this.returnLease();
        },
      };
    } catch (error) {
      this.borrowed = false;
      this.returnLease();
      throw error;
    }
  }

  async close() {
    this.closed = true;
    await this.returned;
    if (!this.entry) return;
    const entry = await this.entry;
    // Physical disposal is still awaited and uses the established failure barrier.
    await releaseModelResource(entry, entry.release);
  }
}

/** The surrounding native activity group owns exclusivity until this cleanup settles. */
export async function withModelWorkload<T>(kind: Kind, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (current.getStore()) throw new Error("Nested model workloads are not supported.");
  const workload = new ModelWorkload(kind, signal);
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    result = await current.run(workload, run);
  } catch (error) {
    failures.push(error);
  }
  try {
    await workload.close();
  } catch (error) {
    if (!failures.includes(error)) failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Model workload and physical cleanup did not complete.");
  return result as T;
}

/** Outside an explicit native workload, preserve the original per-operation lifetime. */
export function acquireModelWorkload<T>(
  kind: Kind,
  identity: string,
  signal: AbortSignal | undefined,
  create: (signal: AbortSignal | undefined) => Promise<Lease<T>>,
): Promise<Lease<T>> {
  const workload = current.getStore();
  if (!workload) return create(signal);
  if (workload.kind !== kind) throw new Error("Unexpected model kind inside the native workload.");
  return workload.acquire(identity, create);
}
