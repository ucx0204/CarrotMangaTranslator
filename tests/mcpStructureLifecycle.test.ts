import { createDeferred } from "./inpaintingSelectionJobFixtures";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createPageRevision } from "../src/shared/pageRevision";
import type { McpPageEditService } from "../src/main/application/mcpPageEditService";
import { McpStructureService } from "../src/main/application/mcpStructureService";
import { McpEditError } from "../src/main/application/mcpEditPolicy";
import { structureFixture } from "./mcpStructure.fixture";

it("claims action IDs across concurrent plans before waiting for page ownership", async () => {
  const f = structureFixture();
  const page = f.chapter.pages[0];
  const opened = createDeferred<void>();
  const finish = createDeferred<void>();
  const commit = vi.fn<McpPageEditService["commitStructure"]>(
    async (_target, _snapshot, _hash, authorize, onCommitted) => {
      opened.resolve();
      await finish.promise;
      authorize();
      onCommitted(page);
      return page;
    },
  );
  const service = new McpStructureService({
    readStructurePage: f.service.readStructurePage.bind(f.service),
    commitStructure: commit,
  });
  const first = await service.preview(f.owner, f.request, f.guard);
  const second = await service.preview(
    f.owner,
    { ...f.request, requestId: randomUUID() },
    f.guard,
  );
  const request = {
    editId: first.editId,
    revision: f.request.revision,
    requestId: randomUUID(),
  };
  const running = service.act(f.owner, request, "apply", f.guard);
  await opened.promise;
  const conflicting = service
    .act(f.owner, { ...request, editId: second.editId }, "apply", f.guard)
    .catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 5));
  finish.resolve();
  await running;
  expect(await conflicting).toMatchObject({ code: "invalid_edit" });
  expect(commit).toHaveBeenCalledOnce();
});

it("keeps a busy plan owned through shutdown and blocks a delayed save", async () => {
  const f = structureFixture();
  const lifetime = new AbortController();
  const waiting = createDeferred<void>();
  const finish = createDeferred<void>();
  const service = new McpStructureService(
    {
      readStructurePage: f.service.readStructurePage.bind(f.service),
      commitStructure: async (
        target,
        snapshot,
        hash,
        authorize,
        onCommitted,
      ) => {
        waiting.resolve();
        await finish.promise;
        return f.service.commitStructure(
          target,
          snapshot,
          hash,
          authorize,
          onCommitted,
        );
      },
    },
    Date.now,
    lifetime.signal,
  );
  const plan = await service.preview(f.owner, f.request, f.guard);
  const request = {
    editId: plan.editId,
    revision: f.request.revision,
    requestId: randomUUID(),
  };
  const running = service
    .act(f.owner, request, "apply", f.guard)
    .catch((error) => error);
  await waiting.promise;
  expect(await service.inspect(f.owner, plan.editId, f.guard)).toMatchObject({
    blockedReason: "busy",
    canApply: false,
  });
  await expect(
    service.act(f.owner, request, "apply", f.guard),
  ).rejects.toMatchObject({ code: "editor_busy" });
  lifetime.abort();
  finish.resolve();
  expect(await running).toMatchObject({ code: "access_denied" });
  expect(f.savePageBlocks).not.toHaveBeenCalled();
});

it("preserves permission errors during inspection and stops expired in-flight commits", async () => {
  const f = structureFixture();
  const plan = await f.structure.preview(f.owner, f.request, f.guard);
  await expect(
    f.structure.inspect(f.owner, plan.editId, () => {
      throw new McpEditError("access_denied", "revoked");
    }),
  ).rejects.toMatchObject({ code: "access_denied" });
  f.assertWritable.mockImplementationOnce(async () => {
    f.tick(30 * 60 * 1000);
  });
  await expect(
    f.structure.act(
      f.owner,
      {
        editId: plan.editId,
        revision: f.request.revision,
        requestId: randomUUID(),
      },
      "apply",
      f.guard,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(f.savePageBlocks).not.toHaveBeenCalled();
});

it("validates malformed requests and invalid direction state without touching storage", async () => {
  const f = structureFixture();
  await expect(
    f.structure.preview(f.owner, { ...f.request, revision: "bad" }, f.guard),
  ).rejects.toMatchObject({ code: "invalid_edit" });
  const plan = await f.structure.preview(f.owner, f.request, f.guard);
  await expect(
    f.structure.act(
      f.owner,
      { editId: plan.editId, revision: f.request.revision, requestId: "bad" },
      "apply",
      f.guard,
    ),
  ).rejects.toMatchObject({ code: "invalid_edit" });
  await expect(
    f.structure.act(
      f.owner,
      {
        editId: plan.editId,
        revision: f.request.revision,
        requestId: randomUUID(),
      },
      "undo",
      f.guard,
    ),
  ).rejects.toMatchObject({ code: "invalid_edit" });
  f.chapter.pages[0].analysisStatus = "running";
  expect(
    await f.structure.inspect(f.owner, plan.editId, f.guard),
  ).toMatchObject({ blockedReason: "busy" });
  f.chapter.pages[0].analysisStatus = "idle";
  f.chapter.pages[0].blocks[0].translatedText = "manual";
  expect(createPageRevision(f.chapter.pages[0])).not.toBe(f.request.revision);
  await expect(
    f.structure.preview(
      f.owner,
      { ...f.request, requestId: randomUUID() },
      f.guard,
    ),
  ).rejects.toMatchObject({ code: "revision_conflict" });
});
