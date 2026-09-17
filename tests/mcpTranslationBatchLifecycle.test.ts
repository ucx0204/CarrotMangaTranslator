import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { expect, it } from "vitest";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import { McpEditError } from "../src/main/application/mcpEditPolicy";

it("cancels a paused save before commit and does not start later pages", async () => {
  const f = translationBatchFixture();
  const before = structuredClone(f.chapter);
  const plan = await f.service.preview(f.owner, f.request(), f.guard);
  const save = f.save.getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.save.mockImplementationOnce(async (...args) => {
    await pending;
    return save(...args);
  });
  const action = f.start(plan.batchId, "apply");
  await tick();
  expect(() => f.start(plan.batchId, "undo")).toThrow(/running/);
  expect(
    f.service.cancel(
      f.owner,
      { batchId: action.batchId, requestId: action.requestId },
      f.guard,
    ).cancellationRequested,
  ).toBe(true);
  expect((await f.inspect(plan.batchId)).status).toBe("running");
  release();
  expect((await f.done(plan.batchId)).status).toBe("cancelled");
  expect(f.chapter).toEqual(before);
  expect(f.save).toHaveBeenCalledTimes(1);
  await f.service.close();
});
it("stops subsequent commits on revocation and preserves the first commit", async () => {
  const f = translationBatchFixture();
  let authorized = true;
  const guard = () => {
    if (!authorized) throw new McpEditError("access_denied", "revoked");
  };
  const plan = await f.service.preview(f.owner, f.request(), guard);
  f.notify.mockImplementationOnce(() => {
    authorized = false;
  });
  f.service.start(
    f.owner,
    { batchId: plan.batchId, requestId: randomUUID() },
    "apply",
    guard,
  );
  const done = await f.done(plan.batchId);
  expect(done.status).toBe("partial");
  expect(done.pages[1].errorCode).toBe("access_denied");
  expect(f.save).toHaveBeenCalledTimes(1);
  await f.service.close();
});
it("shutdown drains a held commit before closing session history", async () => {
  const f = translationBatchFixture();
  const plan = await f.service.preview(f.owner, f.request(), f.guard);
  const save = f.save.getMockImplementation()!;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.save.mockImplementationOnce(async (...args) => {
    await pending;
    return save(...args);
  });
  f.start(plan.batchId, "apply");
  await tick();
  f.lifetime.abort();
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await tick();
  expect(closed).toBe(false);
  release();
  await closing;
  expect(f.chapter.pages[0].blocks[0].translatedText).toBe("original-a");
  await expect(f.inspect(plan.batchId)).rejects.toThrow(/unavailable/);
});
it("old cancellation IDs cannot cancel a later action", async () => {
  const f = translationBatchFixture();
  const plan = await f.service.preview(f.owner, f.request(), f.guard);
  const apply = f.start(plan.batchId, "apply");
  await f.done(plan.batchId);
  expect(
    f.service.cancel(
      f.owner,
      { batchId: apply.batchId, requestId: apply.requestId },
      f.guard,
    ).cancellationRequested,
  ).toBe(false);
  f.start(plan.batchId, "undo");
  expect(() =>
    f.service.cancel(
      f.owner,
      { batchId: apply.batchId, requestId: apply.requestId },
      f.guard,
    ),
  ).toThrow(/currently/);
  await f.done(plan.batchId);
  await f.service.close();
});
it("deduplicates concurrent previews and action claims across plans", async () => {
  const f = translationBatchFixture();
  const input = f.request();
  const [first, replay] = await Promise.all([
    f.service.preview(f.owner, input, f.guard),
    f.service.preview(f.owner, input, f.guard),
  ]);
  expect(replay.batchId).toBe(first.batchId);
  const second = await f.service.preview(f.owner, f.request(), f.guard);
  const action = f.start(first.batchId, "apply");
  expect(f.start(first.batchId, "apply", action.requestId).historical).toBe(
    true,
  );
  expect(() => f.start(second.batchId, "apply", action.requestId)).toThrow(
    /requestId/,
  );
  await f.done(first.batchId);
  await f.service.close();
});
it("expires idle history and enforces the bounded plan count without any writes", async () => {
  const f = translationBatchFixture();
  const first = await f.service.preview(f.owner, f.request(), f.guard);
  for (let index = 1; index < 32; index++)
    await f.service.preview(f.owner, f.request(), f.guard);
  await expect(
    f.service.preview(f.owner, f.request(), f.guard),
  ).rejects.toThrow(/full/);
  f.advance(30 * 60_000 + 1);
  await expect(f.inspect(first.batchId)).rejects.toThrow(/expired/);
  expect(
    (await f.service.preview(f.owner, f.request(), f.guard)).canApply,
  ).toBe(true);
  expect(f.save).not.toHaveBeenCalled();
  await f.service.close();
});
it("paginates exact before/after evidence and returns detached copies", async () => {
  const f = translationBatchFixture();
  const plan = await f.service.preview(f.owner, f.request(), f.guard);
  const first = await f.service.inspect(
    f.owner,
    { batchId: plan.batchId, limit: 1 },
    f.guard,
  );
  expect(first.nextOffset).toBe(1);
  first.changes[0].proposedText = "tampered";
  expect((await f.inspect(plan.batchId)).changes[0].proposedText).toBe(
    "리오가 왔다.",
  );
  const end = await f.service.inspect(
    f.owner,
    { batchId: plan.batchId, offset: 3 },
    f.guard,
  );
  expect(end.changes).toEqual([]);
  expect(end.nextOffset).toBeNull();
  await f.service.close();
});
it("refuses changed chapter order and newly generated text after preview", async () => {
  const f = translationBatchFixture();
  const plan = await f.service.preview(f.owner, f.request(), f.guard);
  f.chapter.pageOrder.reverse();
  f.start(plan.batchId, "apply");
  expect((await f.done(plan.batchId)).pages[0].errorCode).toBe(
    "revision_conflict",
  );
  expect(f.save).not.toHaveBeenCalled();
  await f.service.close();
});
