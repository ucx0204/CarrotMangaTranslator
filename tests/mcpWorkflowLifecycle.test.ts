import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workflowFixture } from "./mcpWorkflow.fixture";

it("holds cancellation until native model cleanup and retries only after explicit permission", async () => {
  const f = await workflowFixture();
  let release!: () => void;
  let finishRequest: () => void = () => {};
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const before = await readFile(f.chapterPath);
    const requestGate = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    f.request.mockImplementationOnce(async () => {
      await requestGate;
      throw new Error("Cancelled deterministic model request");
    });
    f.dispose.mockImplementationOnce(async () => {
      await cleanup;
    });
    const plan = await f.prepare();
    await f.run(plan.id);
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1), {
      timeout: 10000,
    });
    expect(
      await f.invoke("carrot_cancel_workflow", { id: plan.id }),
    ).toMatchObject({ status: "running", cancellationRequested: true });
    await expect(f.run(plan.id)).rejects.toThrow("already running");
    expect((await f.get(plan.id)).status).toBe("running");
    finishRequest();
    await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledTimes(1), {
      timeout: 10000,
    });
    expect((await f.get(plan.id)).status).toBe("running");
    expect(await readFile(f.chapterPath)).toEqual(before);
    release();
    expect(await f.done(plan.id)).toMatchObject({
      status: "cancelled",
      completedSteps: 0,
    });
    const attempted = f.request.mock.calls.length;
    await f.restart();
    await f.run(plan.id);
    expect(await f.done(plan.id)).toMatchObject({
      status: "failed",
      lastError: "invalid_edit",
    });
    expect(f.request).toHaveBeenCalledTimes(attempted);
    await f.run(plan.id, true);
    expect((await f.done(plan.id)).status, JSON.stringify(f.errors)).toBe(
      "completed",
    );
    expect(f.render).toHaveBeenCalledTimes(2);
  } finally {
    finishRequest();
    release();
    await f.close();
  }
});

it("preserves a saved first page while retrying only the failed next page after restart", async () => {
  const f = await workflowFixture();
  try {
    const before = await f.library.openChapter("chapter");
    const firstCount = before.pages[0].blocks.length;
    const request = f.request.getMockImplementation();
    if (!request) throw new Error("Missing model boundary");
    let calls = 0;
    f.request.mockImplementation(async (args) => {
      calls++;
      if (calls === firstCount + 1)
        throw new Error("External transport unavailable");
      return request(args);
    });
    const plan = await f.prepare();
    await f.run(plan.id);
    const failed = await f.done(plan.id);
    expect(failed).toMatchObject({ status: "failed", completedSteps: 1 });
    const first = (await f.library.openChapter("chapter")).pages[0];
    expect(f.render).not.toHaveBeenCalled();
    await f.restart();
    await f.run(plan.id, true);
    expect((await f.done(plan.id)).status, JSON.stringify(f.errors)).toBe(
      "completed",
    );
    const final = await f.library.openChapter("chapter");
    expect(final.pages[0]).toEqual(first);
    expect(f.request).toHaveBeenCalledTimes(
      firstCount + 1 + before.pages[1].blocks.length,
    );
    expect(f.render).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

it("reconciles a native saved page when the following workflow checkpoint cannot be encrypted", async () => {
  const f = await workflowFixture();
  const encrypt = f.encryption.encrypt;
  let failed = false;
  const hook = vi.spyOn(f.encryption, "encrypt").mockImplementation((text) => {
    const value = JSON.parse(text);
    if (value.payload?.steps?.[0]?.status === "completed") {
      failed = true;
      throw new Error(
        "Checkpoint encryption unavailable after native page save",
      );
    }
    return encrypt(text);
  });
  try {
    const before = await f.library.openChapter("chapter");
    const plan = await f.prepare();
    await f.run(plan.id);
    const interrupted = await f.done(plan.id);
    expect(failed).toBe(true);
    expect(interrupted.status).toBe("interrupted");
    expect(f.request).toHaveBeenCalledTimes(before.pages[0].blocks.length);
    const saved = (await f.library.openChapter("chapter")).pages[0];
    expect(saved.blocks[0].translatedText).toBe(
      `translated ${saved.blocks[0].sourceText}`,
    );
    hook.mockRestore();
    await f.restart();
    await f.run(plan.id);
    const completed = await f.done(plan.id);
    expect(completed.status, JSON.stringify(f.errors)).toBe("completed");
    expect(completed.steps[0].changeId).toBeTruthy();
    expect((await f.library.openChapter("chapter")).pages[0]).toEqual(saved);
    expect(f.request).toHaveBeenCalledTimes(
      before.pages.reduce((n, page) => n + page.blocks.length, 0),
    );
  } finally {
    hook.mockRestore();
    await f.close();
  }
});

it("stops before new calls when page-attempt or translation-request budgets are exhausted", async () => {
  const f = await workflowFixture();
  try {
    const translation = await f.prepare(undefined, {
      maxTranslationRequests: 0,
    });
    await f.run(translation.id);
    expect(await f.done(translation.id)).toMatchObject({
      status: "failed",
      pageAttemptsUsed: 0,
      translationRequestsReserved: 0,
    });
    expect(f.request).not.toHaveBeenCalled();
    const outputs = await f.prepare([{ kind: "export-png" }], {
      maxPageAttempts: 1,
    });
    await f.run(outputs.id);
    expect(await f.done(outputs.id)).toMatchObject({
      status: "failed",
      completedSteps: 1,
      pageAttemptsUsed: 1,
    });
    await f.run(outputs.id, true, randomUUID());
    expect((await f.done(outputs.id)).status).toBe("failed");
    expect(f.render).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("waits for pending encrypted admission on close and never starts it after shutdown", async () => {
  const f = await workflowFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seal = f.codec.seal;
  const entered = vi.fn();
  const closed = vi.fn();
  let shutdown: Promise<void> | undefined;
  let admitted: ReturnType<typeof f.run> | undefined;
  const plan = await f.prepare([{ kind: "export-png" }]);
  const hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "status" in value &&
      value.status === "running"
    ) {
      entered();
      await gate;
    }
    return seal(value);
  });
  try {
    admitted = f.run(plan.id);
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    shutdown = f
      .current()
      .workflow.close()
      .then(() => {
        closed();
      });
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
    release();
    await admitted;
    await shutdown;
    expect(closed).toHaveBeenCalledTimes(1);
    expect(f.render).not.toHaveBeenCalled();
    expect(await f.storage.record(plan.id)).toMatchObject({
      status: "cancelled",
    });
  } finally {
    release();
    hook.mockRestore();
    await admitted;
    await shutdown;
    await f.close();
  }
});
