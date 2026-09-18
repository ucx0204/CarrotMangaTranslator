import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { typographyBatchFixture } from "./mcpTypographyBatch.fixture";
import { assertTypographyEvidence } from "../src/main/application/mcpTypographyBatchPolicy";

it("deduplicates concurrent async previews and rejects changed payload under the same request ID", async () => {
  const f = typographyBatchFixture();
  try {
    const input = f.request();
    const [first, second] = await Promise.all([
      f.service.preview(f.owner, input, f.guard),
      f.service.preview(f.owner, input, f.guard),
    ]);
    expect(first.batchId).toBe(second.batchId);
    const changed = { ...input, requestId: randomUUID() };
    const results = await Promise.allSettled([
      f.service.preview(f.owner, changed, f.guard),
      f.service.preview(
        f.owner,
        { ...changed, reason: "different request" },
        f.guard,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["session", "authorization"])(
  "does not publish an async plan after %s is revoked",
  async (kind) => {
    const f = typographyBatchFixture();
    const prepare = f.prepare.getMockImplementation();
    let authorized = true;
    const guard = () => {
      if (!authorized) throw new Error("revoked");
    };
    try {
      if (!prepare) throw new Error("Typography fixture preparation is missing");
      f.prepare.mockImplementationOnce(async (...args) => {
        const result = await prepare(...args);
        if (kind === "session") f.lifetime.abort();
        else authorized = false;
        return result;
      });
      await expect(
        f.service.preview(f.owner, f.request(), guard),
      ).rejects.toThrow();
      expect(f.save).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it.each([
  "page",
  "context",
  "membership",
  "dependency-order",
  "dependency-omission",
])("rejects stale or incomplete %s evidence", async (kind) => {
  const f = typographyBatchFixture();
  try {
    const observation = f.evidence();
    const dependencies = observation.pages.map(({ pageId, revision }) => ({
      pageId,
      revision,
    }));
    if (kind === "page")
      f.chapter.pages[2].blocks[0].translatedText = "later change";
    if (kind === "context") f.saved.styleGuide.rules.honorifics = "drop";
    if (kind === "membership") f.chapter.pageOrder.reverse();
    if (kind === "dependency-order") dependencies.reverse();
    if (kind === "dependency-omission") dependencies.pop();
    expect(() =>
      assertTypographyEvidence(f.saved, observation, dependencies),
    ).toThrow();
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("does not apply a selected page after an unselected analyzed dependency changes", async () => {
  const f = typographyBatchFixture();
  try {
    const request = f.request();
    request.pages = [request.pages[0]];
    const plan = await f.service.preview(f.owner, request, f.guard);
    f.chapter.pages[2].blocks[1].sourceText = "changed analysis context";
    f.start(plan.batchId, "apply");
    const result = await f.done(plan.batchId);
    expect(result.status).toBe("failed");
    expect(result.pages[0].errorCode).toBe("revision_conflict");
    expect(f.save).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("retains a partial save and undoes only committed pages even if context has since changed", async () => {
  const f = typographyBatchFixture();
  const before = structuredClone(f.chapter.pages);
  f.validateRuntime
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("source unavailable"));
  try {
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    f.start(plan.batchId, "apply");
    const partial = await f.done(plan.batchId);
    expect(partial.status).toBe("partial");
    expect(partial.pages.map((page) => page.state)).toEqual([
      "applied",
      "pending",
      "pending",
    ]);
    expect(f.chapter.pages[1]).toEqual(before[1]);
    expect(f.chapter.pages[2]).toEqual(before[2]);
    f.saved.styleGuide.rules.honorifics = "drop";
    f.start(plan.batchId, "undo");
    expect((await f.done(plan.batchId)).status).toBe("completed");
    expect(f.chapter.pages).toEqual(before);
    expect(f.save).toHaveBeenCalledTimes(2);
    f.start(plan.batchId, "redo");
    expect((await f.done(plan.batchId)).status).toBe("failed");
    expect(f.chapter.pages).toEqual(before);
  } finally {
    await f.close();
  }
});

it("records a committed edit before a renderer notification failure and never reapplies its request", async () => {
  const f = typographyBatchFixture();
  const original = structuredClone(f.chapter.pages);
  f.notify.mockImplementationOnce(() => {
    throw new Error("refresh failed");
  });
  try {
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    const action = randomUUID();
    f.start(plan.batchId, "apply", action);
    const partial = await f.done(plan.batchId);
    expect(partial.status).toBe("partial");
    expect(partial.pages[0]).toMatchObject({
      state: "applied",
      result: "saved",
    });
    expect(f.start(plan.batchId, "apply", action).historical).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(1);
    f.start(plan.batchId, "undo");
    await f.done(plan.batchId);
    expect(f.chapter.pages).toEqual(original);
  } finally {
    await f.close();
  }
});

it("stops after a cancellation without rolling back the first saved page", async () => {
  const f = typographyBatchFixture();
  try {
    const plan = await f.service.preview(f.owner, f.request(), f.guard);
    const action = randomUUID();
    f.notify.mockImplementationOnce(() => {
      f.service.cancel(
        f.owner,
        { batchId: plan.batchId, requestId: action },
        f.guard,
      );
    });
    f.start(plan.batchId, "apply", action);
    const cancelled = await f.done(plan.batchId);
    expect(cancelled.status).toBe("partial");
    expect(cancelled.pages[0].state).toBe("applied");
    expect(cancelled.pages[1].result).toBe("cancelled");
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(() =>
      f.service.cancel(
        f.owner,
        { batchId: plan.batchId, requestId: randomUUID() },
        f.guard,
      ),
    ).toThrow();
    f.start(plan.batchId, "undo");
    await f.done(plan.batchId);
    expect(f.chapter.pages[0].blocks[0].sourceFontFacePx).toBeUndefined();
  } finally {
    await f.close();
  }
});

it("refuses to undo subsequent user edits or use another connection's history", async () => {
  const f = typographyBatchFixture();
  try {
    const request = f.request();
    request.pages = [request.pages[0]];
    const plan = await f.service.preview(f.owner, request, f.guard);
    await expect(
      f.service.inspect("other-owner", { batchId: plan.batchId }, f.guard),
    ).rejects.toMatchObject({ code: "not_found" });
    f.start(plan.batchId, "apply");
    await f.done(plan.batchId);
    f.chapter.pages[0].blocks[0].translatedText = "new user wording";
    f.start(plan.batchId, "undo");
    expect((await f.done(plan.batchId)).status).toBe("failed");
    expect(f.chapter.pages[0].blocks[0].translatedText).toBe(
      "new user wording",
    );
    expect(f.save).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("keeps a no-op unchanged, retains observation expiry, and expires session histories", async () => {
  const f = typographyBatchFixture();
  try {
    const input = f.request();
    input.pages = [input.pages[0]];
    const first = await f.service.preview(f.owner, input, f.guard);
    f.start(first.batchId, "apply");
    await f.done(first.batchId);
    f.refreshEvidence();
    const second = await f.service.preview(f.owner, f.request(), f.guard);
    expect(second.pages[0].state).toBe("unchanged");
    f.advance(1800000);
    await expect(f.inspect(second.batchId)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(f.save).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
