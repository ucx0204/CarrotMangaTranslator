import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { workDeletionFixture } from "./mcpWorkDeletion.fixture";
import { createDeferred } from "./inpaintingSelectionJobFixtures";
import { DEFAULT_RASTER_EXPORT_SETTINGS } from "../src/shared/linkedWorkspaceTypes";

it("requires explicit detachment of disabled linked workspaces without altering any external folder", async () => {
  const f = await workDeletionFixture();
  try {
    const imported = await f.create(await f.importCommand(await f.prepare()));
    const { LinkedWorkspaceStore } =
      await import("../src/main/linkedWorkspace/linkedWorkspaceStore");
    const store = new LinkedWorkspaceStore(f.app.appPaths.dataRoot);
    const record = {
      id: randomUUID(),
      workId: imported.workId,
      chapterId: imported.chapterIds[0],
      rootPath: f.env.root,
      enabled: false,
      output: {
        ...DEFAULT_RASTER_EXPORT_SETTINGS,
        destinationMode: "fixed" as const,
      },
      pageRelativePaths: {},
      publishedRevisions: {},
      publishedMirrorRevisions: {},
      sourceFingerprints: {},
      artifacts: {},
      createdAt: "2026-09-21T00:00:00.000Z",
      updatedAt: "2026-09-21T00:00:00.000Z",
    };
    const input = await f.commandWork(imported.workId);
    await store.replaceRecord(record);
    await expect(f.previewWork(imported.workId)).rejects.toThrow(
      /linked workspaces/,
    );
    await expect(f.applyWork(input)).rejects.toThrow(/linked workspaces/);
    expect((await store.readRegistry()).records).toEqual([record]);
    expect((await f.library.openChapter(imported.chapterIds[0])).workId).toBe(
      imported.workId,
    );
    await store.removeRecord(record.id);
    const saved = await f.applyWork(await f.commandWork(imported.workId));
    await f.recoverWork(saved.id, "undo");
    expect((await f.library.openChapter(imported.chapterIds[0])).workId).toBe(
      imported.workId,
    );
  } finally {
    await f.close();
  }
});

it("never releases an existing work-context activity or deletes underneath it", async () => {
  const f = await workDeletionFixture();
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  let pending: Promise<void> | undefined;
  try {
    const { withLibraryContentEdit } = await import("../src/main/library/lock");
    const input = await f.commandWork();
    pending = withLibraryContentEdit(
      [{ kind: "work-context", scope: "work", access: "write" }],
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    await expect(f.applyWork(input)).rejects.toThrow();
    expect(f.app.jobs.gate.activities).toHaveLength(1);
    await f.assertWorkOriginal();
    release.resolve();
    await pending;
    const saved = await f.applyWork(input);
    await f.recoverWork(saved.id, "undo");
    await f.assertWorkOriginal();
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    release.resolve();
    await pending;
    await f.close();
  }
});
