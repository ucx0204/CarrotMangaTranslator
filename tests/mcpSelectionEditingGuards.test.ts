import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { selectionEditingFixture } from "./mcpSelectionEditing.fixture";

it("refuses another connection's analysis, a foreign item, duplicate targets and mixed command kinds", async () => {
  const f = await selectionEditingFixture();
  try {
    const { input } = await f.prepare("translation");
    const before = await readFile(f.chapterPath);
    await expect(f.invoke("carrot_preview_selection_batch", input, "other-owner")).rejects.toThrow();
    const wrong = structuredClone(input);
    wrong.pages[0].edits = wrong.pages[1].edits;
    await expect(f.preview(wrong)).rejects.toThrow(/page|revision/i);
    const duplicate = structuredClone(input);
    duplicate.pages[0].edits.push(duplicate.pages[0].edits[0]);
    await expect(f.preview(duplicate)).rejects.toThrow(/at most once/i);
    await expect(f.preview({ ...input, command: { kind: "references" } })).rejects.toThrow(/separate commands/i);
    await expect(f.preview({ ...input, command: { kind: "analysis", analysisId: randomUUID() } })).rejects.toThrow();
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally { await f.close(); }
});

it.each(["page", "image", "context"] as const)("rejects changed unselected analysis dependency: %s", async (change) => {
  const f = await selectionEditingFixture();
  try {
    const { input } = await f.prepare("source", false);
    const plan = await f.preview(input);
    if (change === "page") await f.mutateStored((chapter) => { chapter.pages[1].blocks[1].sourceText = "later edit"; });
    if (change === "image") await writeFile(f.chapter.pages[1].imagePath, Buffer.concat([f.bytes, Buffer.from("changed")]));
    if (change === "context") {
      const guide = await f.library.getWorkStyleGuide("work");
      guide.rules.honorifics = "drop";
      await f.library.saveWorkStyleGuide(guide);
    }
    const before = await readFile(f.chapterPath);
    const result = (await f.action(plan.batchId, "apply")).result;
    expect(result.status).toBe("failed");
    expect(result.pages[0].errorCode).toBe("revision_conflict");
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally { await f.close(); }
});

it("never copies empty OCR observations over saved text", async () => {
  const f = await selectionEditingFixture();
  try {
    f.collect.mockResolvedValue({ hints: [], diagnostics: [] });
    const before = await readFile(f.chapterPath);
    const { input } = await f.prepare("source");
    const plan = await f.preview(input);
    expect(plan.excludedChanges).toBe(2);
    expect(plan.canApply).toBe(false);
    await expect(f.action(plan.batchId, "apply")).rejects.toThrow(/eligible/i);
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally { await f.close(); }
});

it("records a committed page before a failing UI notification and can undo that partial save", async () => {
  const f = await selectionEditingFixture();
  try {
    const before = await f.snapshot();
    const { input } = await f.prepare("translation");
    const plan = await f.preview(input);
    f.editing.notifySaved.mockImplementationOnce(() => { throw new Error("Synthetic refresh failure"); });
    const result = (await f.action(plan.batchId, "apply")).result;
    expect(result.status).toBe("partial");
    expect(result.pages.map((page) => page.result)).toEqual(["saved", "not_started"]);
    expect((await f.snapshot()).pages[1].blocks).toEqual(before.pages[1].blocks);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("completed");
    expect((await f.snapshot()).pages.map((page) => page.blocks)).toEqual(before.pages.map((page) => page.blocks));
  } finally { await f.close(); }
});

it("cancels a pending native edit without a save and rejects an older cancellation ID", async () => {
  const f = await selectionEditingFixture();
  const gate = { release: () => {}, promise: Promise.resolve() };
  gate.promise = new Promise<void>((resolve) => { gate.release = resolve; });
  try {
    const { input } = await f.prepare("translation");
    const plan = await f.preview(input);
    const before = await readFile(f.chapterPath);
    f.editing.assertWritable.mockImplementation(async () => gate.promise);
    const requestId = randomUUID();
    await f.invoke("carrot_apply_selection_batch", { batchId: plan.batchId, requestId });
    await vi.waitFor(() => expect(f.editing.assertWritable).toHaveBeenCalled());
    await expect(f.invoke("carrot_cancel_selection_batch", { batchId: plan.batchId, requestId: randomUUID() })).rejects.toThrow(/currently inspected/i);
    await f.invoke("carrot_cancel_selection_batch", { batchId: plan.batchId, requestId });
    gate.release();
    expect((await f.done(plan.batchId)).status).toBe("cancelled");
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally { gate.release(); await f.close(); }
});

it("retains undo history after evidence expiry but refuses expired redo", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = await selectionEditingFixture();
  try {
    const before = await f.snapshot();
    const { input } = await f.prepare("translation");
    const plan = await f.preview(input);
    vi.setSystemTime(Date.now() + 29 * 60000);
    expect((await f.action(plan.batchId, "apply")).result.status).toBe("completed");
    vi.setSystemTime(Date.now() + 2 * 60000);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("completed");
    expect((await f.snapshot()).pages.map((page) => page.blocks)).toEqual(before.pages.map((page) => page.blocks));
    const redo = (await f.action(plan.batchId, "redo")).result;
    expect(redo.status).toBe("failed");
    expect(redo.pages[0].errorCode).toBe("not_found");
  } finally { await f.close(); vi.useRealTimers(); }
});

it("does not undo over a later user edit or leak another owner's plan", async () => {
  const f = await selectionEditingFixture();
  try {
    const { input } = await f.prepare("append", false);
    const plan = await f.preview(input);
    await f.action(plan.batchId, "apply");
    await expect(f.invoke("carrot_get_selection_batch", { batchId: plan.batchId }, "other-owner")).rejects.toThrow(/owned/i);
    await f.mutateStored((chapter) => { chapter.pages[0].blocks[0].translatedText = "user edit"; });
    const before = await readFile(f.chapterPath);
    expect((await f.action(plan.batchId, "undo")).result.status).toBe("failed");
    expect(await readFile(f.chapterPath)).toEqual(before);
    f.session.stop();
    await expect(f.inspect(plan.batchId)).rejects.toThrow(/unavailable/i);
  } finally { await f.close(); }
});
