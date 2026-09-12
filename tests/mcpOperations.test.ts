import { describe, expect, it } from "vitest";
import { McpOperationService } from "../src/main/application/mcpOperationService";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function request(
  execute: Parameters<McpOperationService["start"]>[0]["execute"],
) {
  return {
    owner: "connection-a",
    requestId: "r1",
    kind: "ocr",
    parameters: { pageId: "page" },
    assertAuthorized: () => {},
    execute,
  };
}
describe("MCP long-operation receipts", () => {
  it("returns promptly, deduplicates exact retries and isolates connections", async () => {
    let finish!: () => void;
    let calls = 0;
    const service = new McpOperationService(() => {});
    const input = request(async () => {
      calls++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { saved: true };
    });
    const first = service.start(input);
    expect(first.status).toBe("running");
    expect(service.start(input).jobId).toBe(first.jobId);
    expect(() => service.start({ ...input, parameters: {} })).toThrow(
      /requestId/,
    );
    expect(() => service.status(first.jobId, "connection-b")).toThrow(
      /not found/,
    );
    expect(() => service.cancel(first.jobId, "connection-b")).toThrow(
      /not found/,
    );
    await tick();
    finish();
    await tick();
    expect(calls).toBe(1);
    expect(service.status(first.jobId, input.owner).result).toEqual({
      saved: true,
    });
    await service.close();
  });
  it("cancels only owned work and observes failures without exposing private paths", async () => {
    const errors: unknown[] = [];
    const service = new McpOperationService((error) => errors.push(error));
    const input = request(async ({ signal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("C:/private/library/user.png");
    });
    const first = service.start(input);
    await tick();
    service.cancel(first.jobId, input.owner);
    await tick();
    const result = service.status(first.jobId, input.owner);
    expect(result.status).toBe("cancelled");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(errors).toHaveLength(1);
    await service.close();
    expect(() => service.start(input)).toThrow(/stopping/);
  });
  it("rechecks authorization before deferred execution", async () => {
    let revoked = false;
    let called = false;
    const service = new McpOperationService(() => {});
    const first = service.start({
      ...request(async () => {
        called = true;
        return {};
      }),
      assertAuthorized: () => {
        if (revoked) throw new Error("revoked");
      },
    });
    revoked = true;
    await tick();
    expect(called).toBe(false);
    expect(service.status(first.jobId, "connection-a").status).toBe("failed");
    await service.close();
  });
  it("does not pretend a late cancellation rolled back an executor's commit", async () => {
    const service = new McpOperationService(() => {});
    const first = service.start(
      request(async () => {
        service.stop();
        return { committed: true };
      }),
    );
    await service.close();
    // close before execution must cancel. A completed executor is tested separately.
    expect(service.status(first.jobId, "connection-a").status).toBe(
      "cancelled",
    );
    const next = new McpOperationService(() => {});
    const running = next.start(
      request(async () => {
        next.stop();
        return { committed: true };
      }),
    );
    await tick();
    expect(next.status(running.jobId, "connection-a").status).toBe("completed");
  });
});
