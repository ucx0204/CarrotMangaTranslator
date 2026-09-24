import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import { McpWorkflowRecordSchema } from "../src/main/application/mcpWorkflowPolicy";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { deferred } from "./mcpCompositeWorkflow.fixture";
import { newCompositeRecord } from "./mcpCompositeRepository.fixture";

async function nativeWorkflow() {
  const f = await workflowFixture();
  const { createMcpWorkflowSession } =
    await import("../src/main/mcp/mcpWorkflowSession");
  const { McpParentAdmission } =
    await import("../src/main/mcp/mcpParentAdmission");
  const admission = new McpParentAdmission();
  const session = createMcpWorkflowSession({
    app: f.app,
    operations: f.current().operations,
    storage: f.storage,
    preferences: {
      allowEditing: true,
      allowProcessing: true,
      allowImages: true,
      autoStart: false,
    },
    tools: f.current().tools,
    waitSelection: f.current().selection.waitForEdit,
    releaseSelection: f.current().selection.releaseEdit,
    reportError: (error) => {
      f.errors.push(error);
    },
    acquireRun: (owner, input) => admission.acquireWorkflow(owner, input),
  });
  const run = async (input: {
    id: string;
    version: number;
    requestId: string;
    retryFailed: boolean;
  }) => {
    const tool = session.tools.find(
      (item) => item.name === "carrot_run_workflow",
    );
    if (!tool) throw new Error("Missing actual native workflow run tool");
    return f.withExecutionSettings(f.settings, () =>
      tool.invoke(input, f.auth()),
    );
  };
  return { f, session, admission, run };
}

it("preserves native workflow admission, replay and cleanup while sharing the composite gate", async () => {
  const { f, session, admission, run } = await nativeWorkflow();
  const entered = deferred();
  const cleanup = deferred();
  let parentRelease = () => {};
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const input = {
      id: plan.id,
      version: plan.version,
      requestId: randomUUID(),
      retryFailed: false,
    };
    const parent = newCompositeRecord();
    parentRelease = admission.acquireComposite(parent).release;
    await expect(run(input)).rejects.toMatchObject({ code: "editor_busy" });
    expect((await f.get(plan.id)).version).toBe(plan.version);
    expect(f.render).not.toHaveBeenCalled();
    parentRelease();
    const render = f.render.getMockImplementation();
    if (!render) throw new Error("Missing renderer boundary fixture");
    f.render.mockImplementationOnce(async (page) => {
      entered.resolve();
      await cleanup.promise;
      return render(page);
    });
    await run(input);
    await entered.promise;
    await run(input);
    expect(f.render).toHaveBeenCalledTimes(1);
    expect(() => admission.acquireComposite(parent)).toThrow(
      "Another workflow",
    );
    const abort = new AbortController();
    const waiting = session.completion.wait(f.owner, input, abort.signal);
    abort.abort();
    expect(admission.isActive(plan.id)).toBe(true);
    cleanup.resolve();
    expect(await waiting).toMatchObject({ id: plan.id, status: "cancelled" });
    expect(admission.isActive(plan.id)).toBe(false);
  } finally {
    parentRelease();
    cleanup.resolve();
    await session.close();
    await f.close();
  }
});

it("exposes exact settled native workflow evidence across restart without retaining caller mutations", async () => {
  const { f, session, admission, run } = await nativeWorkflow();
  const entered = deferred();
  const cleanup = deferred();
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const input = {
      id: plan.id,
      version: plan.version,
      requestId: randomUUID(),
      retryFailed: false,
    };
    const reference = {
      id: plan.id,
      requestId: input.requestId,
      fingerprint: hashStableValue(["run", input]),
    };
    const render = f.render.getMockImplementation();
    if (!render) throw new Error("Missing renderer boundary fixture");
    f.render.mockImplementationOnce(async (page) => {
      entered.resolve();
      await cleanup.promise;
      return render(page);
    });
    await run(input);
    await entered.promise;
    expect(
      await session.completion.evidence(f.owner, reference),
    ).toBeUndefined();
    expect(admission.isActive(plan.id)).toBe(true);
    const waiting = session.completion.wait(
      f.owner,
      input,
      new AbortController().signal,
    );
    cleanup.resolve();
    expect(await waiting).toMatchObject({
      id: plan.id,
      status: "completed",
      completedSteps: plan.pages.length,
    });
    expect(admission.isActive(plan.id)).toBe(false);
    const record = McpWorkflowRecordSchema.parse(
      await f.storage.record(plan.id),
    );
    const evidence = await session.completion.evidence(f.owner, reference);
    expect(evidence).toEqual(record.pages);
    if (!evidence?.length)
      throw new Error("Missing settled native page evidence");
    evidence[0].pageId = "caller-mutated-page";
    expect(await session.completion.evidence(f.owner, reference)).toEqual(
      record.pages,
    );
    await expect(
      session.completion.evidence("other", reference),
    ).rejects.toMatchObject({ code: "not_found" });
    await session.close();
    await f.restart();
    expect(
      await f.current().workflow.completion.evidence(f.owner, reference),
    ).toEqual(record.pages);
    expect(f.render).toHaveBeenCalledTimes(plan.pages.length);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
  } finally {
    cleanup.resolve();
    await session.close();
    await f.close();
  }
});
