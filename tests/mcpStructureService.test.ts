import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createPageRevision } from "../src/shared/pageRevision";
import { McpStructureService } from "../src/main/application/mcpStructureService";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import { mcpStructureOutputs } from "../src/shared/mcpBlockStructure";
import { structureFixture } from "./mcpStructure.fixture";

async function planned() {
  const f = structureFixture();
  const before = structuredClone(f.chapter);
  const plan = await f.structure.preview(f.owner, f.request, f.guard);
  const action = {
    editId: plan.editId,
    revision: f.request.revision,
    requestId: randomUUID(),
  };
  return { ...f, before, plan, action };
}
it("previews without writes, applies/undoes/redoes atomically and never replays old opposite actions", async () => {
  const f = await planned();
  expect(f.chapter).toEqual(f.before);
  expect(f.savePageBlocks).not.toHaveBeenCalled();
  expect(
    mcpStructureOutputs.carrot_preview_block_structure_edit.safeParse(f.plan)
      .success,
  ).toBe(true);
  expect((await f.structure.preview(f.owner, f.request, f.guard)).editId).toBe(
    f.plan.editId,
  );
  const applied = await f.structure.act(f.owner, f.action, "apply", f.guard);
  expect(applied.pagesChanged).toBe(1);
  expect(f.chapter.pages[0].blocks.map((block) => block.id)).toEqual(["b"]);
  const undoRequest = {
    ...f.action,
    revision: applied.revision,
    requestId: randomUUID(),
  };
  const undone = await f.structure.act(f.owner, undoRequest, "undo", f.guard);
  expect(f.chapter).toEqual(f.before);
  const redoRequest = {
    ...f.action,
    revision: undone.revision,
    requestId: randomUUID(),
  };
  const redone = await f.structure.act(f.owner, redoRequest, "redo", f.guard);
  expect(redone.revision).toBe(applied.revision);
  expect(
    await f.structure.act(f.owner, undoRequest, "undo", f.guard),
  ).toMatchObject({
    status: "already_applied",
    pagesChanged: 0,
    historical: true,
  });
  expect(f.chapter.pages[0].blocks.map((block) => block.id)).toEqual(["b"]);
  expect(f.savePageBlocks).toHaveBeenCalledTimes(3);
  const view = await f.structure.inspect(f.owner, f.plan.editId, f.guard);
  expect(view).toMatchObject({ canUndo: true, canRedo: false });
  expect(JSON.stringify(view)).not.toMatch(
    /PRIVATE|dataUrl|imagePath|resource_link/,
  );
});
it("rejects reused IDs for changed plans and opposite action directions", async () => {
  const f = await planned();
  await expect(
    f.structure.preview(
      f.owner,
      { ...f.request, reason: "different" },
      f.guard,
    ),
  ).rejects.toMatchObject({ code: "invalid_edit" });
  await f.structure.act(f.owner, f.action, "apply", f.guard);
  await expect(
    f.structure.act(f.owner, f.action, "undo", f.guard),
  ).rejects.toMatchObject({ code: "invalid_edit" });
});
it("does not expose another owner's plan or accept unauthenticated calls", async () => {
  const f = await planned();
  await expect(
    f.structure.inspect("other", f.plan.editId, f.guard),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    f.structure.act("other", f.action, "apply", f.guard),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    f.structure.preview("", f.request, f.guard),
  ).rejects.toMatchObject({ code: "access_denied" });
  expect(f.chapter).toEqual(f.before);
});
it("rechecks changed pages before apply or undo without overwriting manual edits", async () => {
  const f = await planned();
  f.chapter.pages[0].blocks[1].translatedText = "manual edit";
  const manual = structuredClone(f.chapter);
  expect(
    await f.structure.inspect(f.owner, f.plan.editId, f.guard),
  ).toMatchObject({ canApply: false, blockedReason: "revision_conflict" });
  await expect(
    f.structure.act(f.owner, f.action, "apply", f.guard),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await expect(
    f.structure.act(
      f.owner,
      { ...f.action, revision: createPageRevision(f.chapter.pages[0]) },
      "apply",
      f.guard,
    ),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(f.chapter).toEqual(manual);
});
it("checks sound-effect ledger drift even though ordinary page revisions exclude it", async () => {
  const f = await planned();
  f.chapter.pages[0].soundEffectReview = {
    contractVersion: 3,
    producer: "hayai-regions-v1",
    regions: [],
    regionOverrides: [],
    manualRegions: [],
    resolvedRegions: [],
  };
  expect(createPageRevision(f.chapter.pages[0])).toBe(f.request.revision);
  await expect(
    f.structure.act(f.owner, f.action, "apply", f.guard),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(f.savePageBlocks).not.toHaveBeenCalled();
});
it("revocation at the commit boundary prevents all writes", async () => {
  const f = await planned();
  let allowed = true;
  f.assertWritable
    .mockImplementationOnce(async () => {})
    .mockImplementationOnce(async () => {
      allowed = false;
    });
  await expect(
    f.structure.act(f.owner, f.action, "apply", () => {
      if (!allowed) throw new McpEditError("access_denied", "revoked");
    }),
  ).rejects.toMatchObject({ code: "access_denied" });
  expect(f.chapter).toEqual(f.before);
  expect(f.savePageBlocks).not.toHaveBeenCalled();
});
it("retains a committed receipt when renderer notification fails", async () => {
  const f = await planned();
  f.notifySaved.mockImplementation(() => {
    throw new Error("renderer unavailable");
  });
  await expect(
    f.structure.act(f.owner, f.action, "apply", f.guard),
  ).rejects.toThrow("renderer unavailable");
  expect(
    await f.structure.act(f.owner, f.action, "apply", f.guard),
  ).toMatchObject({ status: "already_applied", pagesChanged: 0 });
  expect(f.savePageBlocks).toHaveBeenCalledOnce();
});
it("storage failure preserves proposed state for a deliberate retry", async () => {
  const f = await planned();
  f.savePageBlocks.mockRejectedValueOnce(new Error("disk full"));
  await expect(
    f.structure.act(f.owner, f.action, "apply", f.guard),
  ).rejects.toThrow("disk full");
  expect(f.chapter).toEqual(f.before);
  expect(
    await f.structure.inspect(f.owner, f.plan.editId, f.guard),
  ).toMatchObject({ canApply: true, state: "proposed" });
  expect(
    (await f.structure.act(f.owner, f.action, "apply", f.guard)).pagesChanged,
  ).toBe(1);
});
it("expires plans/history, honors lifetime shutdown and reports missing pages without swallowing IO errors", async () => {
  const f = await planned();
  f.openChapter.mockResolvedValueOnce({ ...f.chapter, pages: [] });
  expect(
    await f.structure.inspect(f.owner, f.plan.editId, f.guard),
  ).toMatchObject({ blockedReason: "page_missing", canApply: false });
  f.openChapter.mockRejectedValueOnce(new Error("read denied"));
  await expect(
    f.structure.inspect(f.owner, f.plan.editId, f.guard),
  ).rejects.toThrow("read denied");
  f.tick(30 * 60 * 1000);
  await expect(
    f.structure.inspect(f.owner, f.plan.editId, f.guard),
  ).rejects.toMatchObject({ code: "not_found" });
  const lifetime = new AbortController();
  const service = new McpStructureService(f.service, Date.now, lifetime.signal);
  lifetime.abort();
  await expect(
    service.preview(f.owner, f.request, f.guard),
  ).rejects.toMatchObject({ code: "access_denied" });
});
it("racing preview retries share an ID and competing same-page plans cannot both commit", async () => {
  const f = structureFixture();
  const [first, duplicate] = await Promise.all([
    f.structure.preview(f.owner, f.request, f.guard),
    f.structure.preview(f.owner, f.request, f.guard),
  ]);
  expect(first.editId).toBe(duplicate.editId);
  const second = await f.structure.preview(
    f.owner,
    { ...f.request, requestId: randomUUID() },
    f.guard,
  );
  const action = {
    revision: f.request.revision,
    requestId: randomUUID(),
    editId: first.editId,
  };
  await f.structure.act(f.owner, action, "apply", f.guard);
  await expect(
    f.structure.act(
      f.owner,
      { ...action, editId: second.editId, requestId: randomUUID() },
      "apply",
      f.guard,
    ),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(f.savePageBlocks).toHaveBeenCalledOnce();
});
it("refuses history capacity overflow without evicting unexpired recovery", async () => {
  const f = structureFixture();
  for (let i = 0; i < 64; i++)
    await f.structure.preview(
      f.owner,
      { ...f.request, requestId: randomUUID() },
      f.guard,
    );
  await expect(
    f.structure.preview(
      f.owner,
      { ...f.request, requestId: randomUUID() },
      f.guard,
    ),
  ).rejects.toMatchObject({ code: "editor_busy" });
  expect(f.savePageBlocks).not.toHaveBeenCalled();
});
