import assert from "node:assert/strict";
import { it } from "vitest";
import { McpServerLifecycle } from "../src/main/mcp/mcpServerLifecycle";

function lease() {
  const calls = { stopped: 0, closed: 0 };
  return {
    calls,
    stopAccepting: () => {
      calls.stopped++;
    },
    close: async () => {
      calls.closed++;
    },
  };
}

it("creates a single lease for concurrent starts and closes it once", async () => {
  const server = lease();
  let starts = 0;
  const lifecycle = new McpServerLifecycle(async () => {
    starts++;
    return server;
  });
  await Promise.all([lifecycle.start(), lifecycle.start()]);
  assert.equal(starts, 1);
  const closing = lifecycle.dispose();
  assert.equal(lifecycle.dispose(), closing);
  await closing;
  assert.equal(server.calls.closed, 1);
});

it("does not start after disposal, including when it was never enabled", async () => {
  let starts = 0;
  const lifecycle = new McpServerLifecycle(async () => {
    starts++;
    return null;
  });
  await lifecycle.dispose();
  await assert.rejects(lifecycle.start());
  assert.equal(starts, 0);
});

it("closes a late listener when shutdown overtakes startup", async () => {
  const server = lease();
  let release!: (value: typeof server) => void;
  const pending = new Promise<typeof server>((resolve) => {
    release = resolve;
  });
  const lifecycle = new McpServerLifecycle(() => pending);
  const starting = lifecycle.start();
  const closing = lifecycle.dispose();
  release(server);
  await Promise.all([starting, closing]);
  assert.equal(server.calls.closed, 1);
  assert.ok(server.calls.stopped > 0);
});

it("reports startup failure to its caller without inventing a cleanup lease", async () => {
  const failure = new Error("listener unavailable");
  const lifecycle = new McpServerLifecycle(async () => {
    throw failure;
  });
  await assert.rejects(lifecycle.start(), (error) => error === failure);
  await lifecycle.dispose();
});

it("preserves close failures on repeated disposal", async () => {
  const failure = new Error("close failed");
  const lifecycle = new McpServerLifecycle(async () => ({
    stopAccepting: () => {},
    close: async () => {
      throw failure;
    },
  }));
  await lifecycle.start();
  const closing = lifecycle.dispose();
  assert.equal(lifecycle.dispose(), closing);
  await assert.rejects(closing, (error) => error === failure);
});

it("closes intake synchronously before asynchronous cleanup", async () => {
  const server = lease();
  const lifecycle = new McpServerLifecycle(async () => server);
  await lifecycle.start();
  lifecycle.stopAccepting();
  assert.equal(server.calls.stopped, 1);
  assert.equal(server.calls.closed, 0);
  await lifecycle.dispose();
});

it("allows the explicitly disabled factory to start and dispose without resources", async () => {
  const lifecycle = new McpServerLifecycle(async () => null);
  await lifecycle.start();
  await lifecycle.dispose();
});
