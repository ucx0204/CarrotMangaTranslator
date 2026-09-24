import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { hashStableValue } from "../src/shared/blockFingerprint";
import { McpResearchBatchRunSchema } from "../src/shared/mcpResearchBatch";
import { workflowFixture } from "./mcpWorkflow.fixture";
import { researchBatchFixture } from "./mcpResearchBatch.fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function reference(input: { id: string; requestId: string }) {
  return {
    id: input.id,
    requestId: input.requestId,
    fingerprint: hashStableValue(["run", input]),
  };
}

it("waits for the actual workflow renderer to settle after cancellation", async () => {
  const f = await workflowFixture();
  const entered = deferred();
  const release = deferred();
  try {
    const render = f.render.getMockImplementation();
    if (!render) throw new Error("Missing native renderer fixture");
    f.render.mockImplementationOnce(async (page) => {
      entered.resolve();
      await release.promise;
      return render(page);
    });
    const plan = await f.prepare([{ kind: "export-png" }]);
    const { input } = await f.run(plan.id);
    await entered.promise;
    const cancellation = new AbortController();
    let settled = false;
    const waiting = f
      .current()
      .workflow.completion.wait(f.owner, input, cancellation.signal)
      .finally(() => {
        settled = true;
      });
    cancellation.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect(await waiting).toMatchObject({ id: plan.id, status: "cancelled" });
    expect(f.render).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await f.close();
  }
});

it("finds a completed exact workflow receipt after reconstruction without rendering again", async () => {
  const f = await workflowFixture();
  try {
    const plan = await f.prepare([{ kind: "export-png" }]);
    const { input } = await f.run(plan.id);
    await f
      .current()
      .workflow.completion.wait(f.owner, input, new AbortController().signal);
    await f.restart();
    expect(
      await f.current().workflow.completion.find(f.owner, reference(input)),
    ).toMatchObject({ status: "completed" });
    await expect(
      f.current().workflow.completion.find(f.owner, {
        ...reference(input),
        fingerprint: "f".repeat(16),
      }),
    ).rejects.toThrow("different input");
    await expect(
      f.current().workflow.completion.find("another-owner", reference(input)),
    ).rejects.toThrow();
    expect(f.render).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

it("pauses a native research batch after its admitted model settles and owns only that exact run", async () => {
  const f = await researchBatchFixture(2);
  const entered = deferred();
  const release = deferred();
  try {
    const research = f.research.getMockImplementation();
    if (!research) throw new Error("Missing native research fixture");
    f.research.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return research(...args);
    });
    const plan = await f.prepare();
    const input = McpResearchBatchRunSchema.parse({
      id: plan.id,
      version: plan.version,
      requestId: randomUUID(),
      allowExternal: true,
      allowAssetDownloads: true,
    });
    await f.invoke("carrot_run_research_batch", input);
    await entered.promise;
    const completion = f.current().batch.completion;
    await completion.control("migration-owner", reference(input), "pause");
    let settled = false;
    const waiting = completion
      .wait("migration-owner", input, new AbortController().signal)
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    expect(await waiting).toMatchObject({
      id: plan.id,
      status: "paused",
      attemptsUsed: 1,
    });
    expect(f.research).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await f.close();
  }
});
