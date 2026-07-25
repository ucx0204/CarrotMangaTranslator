import { describe, expect, it } from "vitest";
import { AbortableExclusiveGate } from "../src/main/runtimeSupport/abortableExclusiveGate";

describe("AbortableExclusiveGate", () => {
  it("grants one FIFO lease at a time and ignores duplicate releases", async () => {
    const gate = new AbortableExclusiveGate();
    const first = await gate.acquire();
    let secondAcquired = false;
    let thirdAcquired = false;
    const secondPromise = gate.acquire().then((lease) => {
      secondAcquired = true;
      return lease;
    });
    const thirdPromise = gate.acquire().then((lease) => {
      thirdAcquired = true;
      return lease;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    expect(thirdAcquired).toBe(false);

    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    expect(thirdAcquired).toBe(false);

    first.release();
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    second.release();
    const third = await thirdPromise;
    expect(thirdAcquired).toBe(true);
    third.release();
  });

  it("removes an aborted waiter without disturbing the active owner", async () => {
    const gate = new AbortableExclusiveGate();
    const active = await gate.acquire();
    const controller = new AbortController();
    const aborted = gate.acquire(controller.signal);
    const next = gate.acquire();

    controller.abort();

    await expect(aborted).rejects.toMatchObject({
      name: "AbortError",
      message: "Aborted",
    });
    active.release();
    await expect(next).resolves.toEqual({ release: expect.any(Function) });
  });

  it("rejects an already-aborted signal without taking ownership", async () => {
    const gate = new AbortableExclusiveGate();
    const controller = new AbortController();
    controller.abort();

    await expect(gate.acquire(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const lease = await gate.acquire();
    lease.release();
  });
});
