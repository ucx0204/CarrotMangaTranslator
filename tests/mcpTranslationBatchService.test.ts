import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { translationBatchFixture } from "./mcpTranslationBatch.fixture";
import { mcpTranslationBatchOutputs } from "../src/shared/mcpTranslationBatch";

it("previews without saving then applies/undoes/redoes only explicit translations", async () => {
  const f = translationBatchFixture();
  const before = structuredClone(f.saved);
  const input = f.request();
  const preview = await f.service.preview(f.owner, input, f.guard);
  expect(f.save).not.toHaveBeenCalled();
  expect(f.saved).toEqual(before);
  expect(preview.totalChanges).toBe(3);
  expect(await f.service.preview(f.owner, input, f.guard)).toEqual(preview);
  const action = f.start(preview.batchId, "apply");
  expect(action.status).toBe("accepted");
  const applied = await f.done(preview.batchId);
  expect(applied.status).toBe("completed");
  expect(f.save).toHaveBeenCalledTimes(3);
  for (const [index, page] of f.chapter.pages.entries()) {
    const expected = structuredClone(before.chapter.pages[index]);
    expected.blocks[0].translatedText = "리오가 왔다.";
    expect(page).toEqual(expected);
  }
  expect(mcpTranslationBatchOutputs.carrot_get_translation_batch.safeParse(applied).success).toBe(true);
  const undo = f.start(preview.batchId, "undo");
  await f.done(preview.batchId);
  expect(f.saved).toEqual(before);
  f.start(preview.batchId, "redo");
  expect((await f.done(preview.batchId)).status).toBe("completed");
  expect(f.start(preview.batchId, "undo", undo.requestId)).toMatchObject({ status: "already_started", historical: true });
  expect((await f.inspect(preview.batchId)).pages.every((page) => page.state === "applied")).toBe(true);
  f.start(preview.batchId, "undo");
  await f.done(preview.batchId);
  expect(f.saved).toEqual(before);
  expect(f.start(preview.batchId, "apply", action.requestId).status).toBe("already_started");
  expect(f.saved).toEqual(before);
  await f.service.close();
});
it("stops on a middle-page conflict and preserves explicit progress for restoration", async () => {
  const f = translationBatchFixture();
  const plan = await f.service.preview(f.owner, f.request(), f.guard);
  f.chapter.pages[1].blocks[1].translatedText = "manual later edit";
  f.start(plan.batchId, "apply");
  const partial = await f.done(plan.batchId);
  expect(partial.status).toBe("partial");
  expect(partial.pages.map((page) => [page.state, page.result])).toEqual([
    ["applied", "saved"], ["pending", "failed"], ["pending", "not_started"],
  ]);
  expect(partial.pages[1].errorCode).toBe("revision_conflict");
  expect(() => f.start(plan.batchId, "apply")).toThrow(/Replan/);
  f.start(plan.batchId, "undo");
  await f.done(plan.batchId);
  expect(f.chapter.pages[0].blocks[0].translatedText).toBe("original-a");
  expect(f.chapter.pages[1].blocks[1].translatedText).toBe("manual later edit");
  expect(f.chapter.pages[2].blocks[0].translatedText).toBe("original-a");
  await f.service.close();
});
it("protects changed context before apply/redo but permits page-safe undo", async () => {
  const f = translationBatchFixture();
  const first = await f.service.preview(f.owner, f.request(), f.guard);
  f.saved.styleGuide.rules.honorifics = "drop";
  expect((await f.inspect(first.batchId)).canApply).toBe(false);
  f.start(first.batchId, "apply");
  expect((await f.done(first.batchId)).status).toBe("failed");
  expect(f.save).not.toHaveBeenCalled();
  const next = await f.service.preview(f.owner, f.request(), f.guard);
  f.start(next.batchId, "apply"); await f.done(next.batchId);
  f.saved.styleGuide.rules.honorifics = "adapt";
  f.start(next.batchId, "undo"); await f.done(next.batchId);
  expect((await f.inspect(next.batchId)).canRedo).toBe(false);
  f.start(next.batchId, "redo");
  expect((await f.done(next.batchId)).status).toBe("failed");
  expect(f.chapter.pages[0].blocks[0].translatedText).toBe("original-a");
  await f.service.close();
});
it("does not overwrite later edits even with a new action requestId", async () => {
  const f = translationBatchFixture();
  const plan = await f.service.preview(f.owner, f.request(), f.guard);
  f.start(plan.batchId, "apply"); await f.done(plan.batchId);
  f.chapter.pages[0].blocks[1].translatedText = "keep user change";
  f.start(plan.batchId, "undo");
  expect((await f.done(plan.batchId)).status).toBe("failed");
  expect(f.chapter.pages[0].blocks[1].translatedText).toBe("keep user change");
  expect(f.chapter.pages[1].blocks[0].translatedText).toBe("리오가 왔다.");
  await f.service.close();
});
it("excludes generated lettering and no-ops without treating them as saved changes", async () => {
  const f = translationBatchFixture();
  const block = f.chapter.pages[0].blocks[0];
  block.generatedLettering = { version: 1, dataUrl: "PRIVATE", sourceText: "source", translatedText: block.translatedText };
  const input = f.request();
  input.pages[1].edits[0].translatedText = "original-a";
  const plan = await f.service.preview(f.owner, input, f.guard);
  expect(plan.pages.map((page) => page.state)).toEqual(["excluded", "unchanged", "pending"]);
  expect(plan.excludedChanges).toBe(1);
  f.start(plan.batchId, "apply");
  const done = await f.done(plan.batchId);
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(block.translatedText).toBe("original-a");
  expect(JSON.stringify(done)).not.toContain("PRIVATE");
  await f.service.close();
});
it("rejects duplicate targets, missing blocks, emptying and stale preview revisions", async () => {
  const f = translationBatchFixture();
  const base = f.request();
  const invalid = [
    { ...base, pages: [base.pages[0], base.pages[0]] },
    { ...base, pages: [{ ...base.pages[0], edits: [base.pages[0].edits[0], base.pages[0].edits[0]] }] },
    { ...base, pages: [{ ...base.pages[0], pageId: "missing" }] },
    { ...base, pages: [{ ...base.pages[0], edits: [{ ...base.pages[0].edits[0], blockId: "missing" }] }] },
    { ...base, pages: [{ ...base.pages[0], edits: [{ ...base.pages[0].edits[0], translatedText: " " }] }] },
    { ...base, contextRevision: "f".repeat(16) },
    { ...base, pages: [{ ...base.pages[0], revision: "page-v1:" + "f".repeat(16) }] },
  ];
  for (const value of invalid) await expect(f.service.preview(f.owner, value, f.guard)).rejects.toThrow();
  const clearing = { ...invalid[4], allowEmpty: true };
  expect((await f.service.preview(f.owner, clearing, f.guard)).canApply).toBe(true);
  expect(f.save).not.toHaveBeenCalled();
  await f.service.close();
});
it("rejects reused IDs across directions/plans and never leaks other owners' history", async () => {
  const f = translationBatchFixture();
  const input = f.request();
  const plan = await f.service.preview(f.owner, input, f.guard);
  await expect(f.service.preview(f.owner, { ...input, reason: "different" }, f.guard)).rejects.toThrow(/requestId/);
  await expect(f.service.inspect("other", { batchId: plan.batchId }, f.guard)).rejects.toThrow(/owned/);
  expect(() => f.service.start("other", { batchId: plan.batchId, requestId: randomUUID() }, "apply", f.guard)).toThrow();
  const action = f.start(plan.batchId, "apply"); await f.done(plan.batchId);
  expect(() => f.start(plan.batchId, "undo", action.requestId)).toThrow(/requestId/);
  await f.service.close();
});
it("records a committed page before a refresh failure and never blindly reapplies it", async () => {
  const f = translationBatchFixture();
  const plan = await f.service.preview(f.owner, f.request(), f.guard);
  f.notify.mockImplementationOnce(() => { throw new Error("private notification failure"); });
  const action = f.start(plan.batchId, "apply");
  const done = await f.done(plan.batchId);
  expect(done.status).toBe("partial");
  expect(done.pages[0]).toMatchObject({ state: "applied", result: "saved" });
  expect(f.save).toHaveBeenCalledTimes(1);
  f.start(plan.batchId, "apply", action.requestId);
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(done)).not.toContain("private notification");
  f.start(plan.batchId, "undo"); await f.done(plan.batchId);
  expect(f.chapter.pages[0].blocks[0].translatedText).toBe("original-a");
  await f.service.close();
});
