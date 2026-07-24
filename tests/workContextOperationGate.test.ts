import { describe, expect, it, vi } from "vitest";
import { WorkContextOperationGate } from "../src/main/ipc/workContextIpc";

function createGate(isJobActive = false): WorkContextOperationGate {
  return new WorkContextOperationGate({
    createBusyError: () => new Error("busy"),
    isJobActive: () => isJobActive,
  });
}

describe("WorkContextOperationGate", () => {
  it("rejects operations while another job owns the runtime", async () => {
    const operation = vi.fn(async () => "unused");

    await expect(createGate(true).run(operation)).rejects.toThrow("busy");
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a concurrent operation without running its side effects", async () => {
    let releaseFirst: (() => void) | undefined;
    const first = createGate();
    const running = first.run(
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve("completed");
        }),
    );
    const concurrent = vi.fn(async () => "should-not-run");

    await expect(first.run(concurrent)).rejects.toThrow("busy");
    expect(concurrent).not.toHaveBeenCalled();
    releaseFirst?.();
    await expect(running).resolves.toBe("completed");
  });

  it("releases ownership after a failed operation", async () => {
    const gate = createGate();

    await expect(
      gate.run(async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    await expect(gate.run(async () => "retried")).resolves.toBe("retried");
  });
});
