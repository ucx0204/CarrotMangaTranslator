import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  reviewedWorkspace,
  reviewedExecution,
  reviewedTarget,
  REVIEW_PNG,
  type ReviewedFixture,
} from "./linkedWorkspaceReviewedOutput.fixture";

vi.mock("electron", () => ({
  app: { getVersion: () => "native-parity" },
  shell: { openPath: vi.fn() },
}));
const fixtures: ReviewedFixture[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
});
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  vi.useRealTimers();
  vi.clearAllMocks();
});
async function setup(counts = [1]) {
  const fixture = await reviewedWorkspace(counts);
  fixtures.push(fixture);
  return fixture;
}
async function resultPath(f: ReviewedFixture) {
  const record = (await f.registry()).records.find(
    (record: { id: string }) => record.id === f.selection.connectionId,
  );
  const id = f.selection.pageIds[0];
  if (!id || !record) throw new Error("fixture target missing");
  const relative = record.resultRelativePaths?.[id];
  if (!relative) throw new Error("fixture allocation missing");
  return join(f.output, relative);
}

describe("reviewed native publication boundaries", () => {
  it("does not publish a result when durable intent persistence rejects", async () => {
    const f = await setup();
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const execution = reviewedExecution({
      onIntent: async () => {
        throw new Error("receipt storage failed");
      },
    });
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "receipt_failed",
      publishedBytes: 0,
    });
    expect(execution.effects).toHaveLength(0);
    await expect(readFile(await resultPath(f))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(dirname(await resultPath(f)))).filter((name) =>
        name.endsWith(".tmp"),
      ),
    ).toEqual([]);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("keeps a published result unconfirmed if the post-effect receipt write fails", async () => {
    const f = await setup();
    const registry = await readFile(join(f.dataRoot, "linked-workspaces.json"));
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const execution = reviewedExecution({
      onEffect: async () => {
        throw new Error("effect receipt failed");
      },
    });
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    expect(result).toMatchObject({
      status: "partial",
      errorCode: "receipt_failed",
      metadata: "pending",
      mirror: "pending",
    });
    expect(result.files.find((file) => file.role === "result")?.state).toBe(
      "publication_unconfirmed",
    );
    expect(await readFile(await resultPath(f), "utf8")).toBe(
      "native-render:" + f.selection.pageIds[0],
    );
    expect(await readFile(join(f.dataRoot, "linked-workspaces.json"))).toEqual(
      registry,
    );
    expect(execution.intents).toHaveLength(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("reports renderer cleanup failures with their original cause while preserving already published effects", async () => {
    const f = await setup();
    const failure = new Error("renderer close failed");
    f.close.mockImplementationOnce(() => {
      throw failure;
    });
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      reviewedExecution().context,
    );
    expect(result).toMatchObject({
      status: "partial",
      metadata: "published",
      mirror: "published",
    });
    expect(f.reportError).toHaveBeenCalledWith(
      "Reviewed linked output publication failed",
      expect.any(AggregateError),
    );
    const detail = f.reportError.mock.calls[0]?.[1];
    expect(detail).toBeInstanceOf(AggregateError);
    if (!(detail instanceof AggregateError))
      throw new Error("missing native cleanup report");
    expect(detail.errors).toContain(failure);
  });

  it("settles an already published effect after cancellation and attempts no later file", async () => {
    const f = await setup();
    const queue = await f.queue();
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const execution = reviewedExecution();
    const effects = execution.context.onEffect;
    execution.context.onEffect = async (effect) => {
      execution.controller.abort();
      await effects(effect);
    };
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    expect(result.status).toBe("cancelled");
    expect(result.files.find((file) => file.role === "result")?.state).toBe(
      "published",
    );
    expect(execution.intents).toHaveLength(1);
    expect(execution.effects).toHaveLength(1);
    expect(result.metadata).toBe("pending");
    expect(result.mirror).toBe("pending");
    expect(await f.queue()).toBe(queue);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("rechecks authority after preparing an intent and before the OS rename", async () => {
    const f = await setup();
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    let allowed = true;
    const execution = reviewedExecution({
      assertAuthorized: () => {
        if (!allowed) throw new Error("revoked");
      },
      onIntent: async () => {
        allowed = false;
      },
    });
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    expect(result.status).toBe("failed");
    expect(result.publishedBytes).toBe(0);
    await expect(readFile(await resultPath(f))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(execution.effects).toHaveLength(0);
  });

  it("verifies copied bytes and source currency after the intent, preserving prior result publication", async () => {
    const f = await setup();
    const page = f.chapters[0]?.pages[0];
    if (!page?.inpaintedImagePath) throw new Error("fixture source missing");
    const cleanedPath = page.inpaintedImagePath;
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const execution = reviewedExecution();
    const persist = execution.context.onIntent;
    execution.context.onIntent = async (intent) => {
      await persist(intent);
      if (intent.role === "inpainted") {
        const changed = Buffer.from(REVIEW_PNG);
        changed[changed.length - 1] ^= 1;
        await writeFile(cleanedPath, changed);
      }
    };
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    expect(result).toMatchObject({
      status: "partial",
      errorCode: "source_changed",
    });
    expect(execution.effects.map((effect) => effect.fileId)).toEqual([
      "result:" + page.id + ":publish",
    ]);
    expect(result.files.find((file) => file.role === "inpainted")?.state).toBe(
      "failed",
    );
    expect(result.metadata).toBe("pending");
  });

  it("retains native registry state after its rename even if recording that effect fails", async () => {
    const f = await setup();
    const review = await f.service.reviewedOutput.preflight(
      f.selection,
      () => undefined,
    );
    const execution = reviewedExecution();
    const settle = execution.context.onEffect;
    execution.context.onEffect = async (effect) => {
      if (effect.fileId.startsWith("registry:"))
        throw new Error("registry effect receipt lost");
      await settle(effect);
    };
    const result = await f.service.reviewedOutput.execute(
      reviewedTarget(review),
      execution.context,
    );
    expect(result).toMatchObject({
      status: "partial",
      metadata: "publication_unconfirmed",
      mirror: "pending",
    });
    const record = (await f.registry()).records[0];
    if (!record) throw new Error("fixture record missing");
    expect(
      record.artifacts[f.selection.pageIds[0] ?? ""]?.result,
    ).toBeDefined();
    await expect(
      f.service.reviewedOutput.preflight(f.selection, () => undefined),
    ).resolves.toHaveProperty("selectionSnapshot");
    expect(
      execution.intents.filter((intent) => intent.role === "registry"),
    ).toHaveLength(1);
  });

  it("requires unselected shared-root artifacts to match the hashes the full mirror will retain", async () => {
    const f = await setup([1, 1]);
    const chapter = f.chapters[1];
    const record = (await f.registry()).records.find(
      (record) => record.chapterId === chapter?.id,
    );
    if (!chapter || !record)
      throw new Error("fixture unselected chapter missing");
    const other = {
      chapterId: chapter.id,
      connectionId: record.id,
      pageIds: chapter.pageOrder,
    };
    const initial = await f.service.reviewedOutput.preflight(
      other,
      () => undefined,
    );
    const published = await f.service.reviewedOutput.execute(
      reviewedTarget(initial),
      reviewedExecution().context,
    );
    expect(published.status).toBe("completed");
    const otherRecord = (await f.registry()).records.find(
      (item) => item.id === record.id,
    );
    const artifact = otherRecord?.artifacts[chapter.pageOrder[0] ?? ""]?.result;
    if (!artifact) throw new Error("fixture unselected output missing");
    await writeFile(
      join(f.output, artifact.path),
      "externally changed unselected output",
    );
    const registry = await readFile(join(f.dataRoot, "linked-workspaces.json"));
    await expect(
      f.service.reviewedOutput.preflight(f.selection, () => undefined),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(await readFile(join(f.dataRoot, "linked-workspaces.json"))).toEqual(
      registry,
    );
    expect(f.renderPage).toHaveBeenCalledTimes(1);
    await expect(
      f.service.reviewedOutput.preflight(other, () => undefined),
    ).resolves.toHaveProperty("sourceSnapshot");
  });

  it.each(["name", "source", "target"] as const)(
    "rejects %s drift before any renderer or destination publication",
    async (change) => {
      const f = await setup();
      const page = f.chapters[0]?.pages[0];
      if (!page) throw new Error("fixture page missing");
      const review = await f.service.reviewedOutput.preflight(
        f.selection,
        () => undefined,
      );
      if (change === "name") page.name = "renamed.png";
      if (change === "source") {
        const changed = Buffer.from(REVIEW_PNG);
        changed[changed.length - 1] ^= 1;
        await writeFile(page.imagePath, changed);
      }
      if (change === "target") {
        const path = await resultPath(f);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, "unowned file");
      }
      await expect(
        f.service.reviewedOutput.execute(
          reviewedTarget(review),
          reviewedExecution().context,
        ),
      ).rejects.toHaveProperty("code");
      expect(f.createRenderer).not.toHaveBeenCalled();
    },
  );

  it("blocks hidden legacy mask preparation and destination junctions", async () => {
    const f = await setup();
    const page = f.chapters[0]?.pages[0];
    if (!page) throw new Error("fixture page missing");
    delete page.inpaintMaskPath;
    await expect(
      f.service.reviewedOutput.preflight(f.selection, () => undefined),
    ).rejects.toMatchObject({ code: "legacy_preparation_required" });
    expect(f.updatePagesAfterInpainting).not.toHaveBeenCalled();
    delete page.inpaintedImagePath;
    const outside = join(f.directory, "outside");
    await mkdir(outside);
    await symlink(outside, join(f.output, "result"), "junction");
    await expect(
      f.service.reviewedOutput.preflight(f.selection, () => undefined),
    ).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it.each([{ counts: [51] }, { counts: Array.from({ length: 11 }, () => 1) }])(
    "rejects complete mirror scope beyond the native MCP bounds",
    async ({ counts }) => {
      const f = await setup(counts);
      await expect(
        f.service.reviewedOutput.preflight(
          {
            ...f.selection,
            pageIds: f.selection.pageIds.slice(0, 1),
          },
          () => undefined,
        ),
      ).rejects.toMatchObject({ code: "limit_exceeded" });
      expect(f.createRenderer).not.toHaveBeenCalled();
    },
  );
});
