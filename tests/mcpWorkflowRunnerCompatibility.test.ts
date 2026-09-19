import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { McpWorkflowRecordSchema } from "../src/main/application/mcpWorkflowPolicy";
import {
  runMcpWorkflow,
  type McpWorkflowRuntime,
} from "../src/main/application/mcpWorkflowRunner";
import { McpWorkflowRepository } from "../src/main/mcp/mcpWorkflowRepository";

it("preserves external waiting for a runtime port without a model-group boundary", async () => {
  const f = await workflowFixture();
  try {
    const before = await readFile(f.chapterPath);
    const plan = await f.prepare([{ kind: "await-external", purpose: "reading" }]);
    const record = McpWorkflowRecordSchema.parse(await f.storage.record(plan.id));
    const repository = new McpWorkflowRepository(f.storage);
    // This is a runner contract test: the native evidence and model ports are not
    // claimed to run. An external-wait step must never call the execution port.
    const runtime: McpWorkflowRuntime = {
      verify: vi.fn(async () => undefined),
      cost: vi.fn(async () => 0),
      execute: vi.fn(async () => { throw new Error("External wait must not execute"); }),
      reconcile: vi.fn(async () => undefined),
    };
    const reportError = vi.fn();
    record.status = "running";
    await runMcpWorkflow({
      save: (value, version) => repository.save(value, version),
      open: async () => runtime,
      now: Date.now,
      reportError,
    }, {
      record, controller: new AbortController(), pause: false, done: Promise.resolve(),
    }, () => {}, false);
    expect(record.status).toBe("waiting_external");
    expect(record.steps[0].status).toBe("waiting_external");
    expect(record.pageAttemptsUsed).toBe(0);
    expect(await repository.load(f.owner, plan.id)).toMatchObject({ status: "waiting_external" });
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(runtime.cost).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(await readFile(f.chapterPath)).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
