import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { chapterMoveFixture } from "./mcpChapterMove.fixture";
import { createDeferred } from "./inpaintingSelectionJobFixtures";
import { DEFAULT_RASTER_EXPORT_SETTINGS } from "../src/shared/linkedWorkspaceTypes";

it("requires explicit unlinking even for a disabled linked-workspace record and never retargets external folders", async () => {
  const f = await chapterMoveFixture();
  try {
    const imported = await f.create(await f.importCommand(await f.prepare()));
    const chapterId = imported.chapterIds[0];
    const intent = {
      workId: imported.workId,
      chapterId,
      destinationWorkId: "destination",
    };
    const { LinkedWorkspaceStore } =
      await import("../src/main/linkedWorkspace/linkedWorkspaceStore");
    const store = new LinkedWorkspaceStore(f.app.appPaths.dataRoot);
    const record = {
      id: randomUUID(),
      workId: imported.workId,
      chapterId,
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
    await store.replaceRecord(record);
    await expect(f.previewMove(intent)).rejects.toThrow(/linked workspace/);
    expect((await store.readRegistry()).records).toEqual([record]);
    expect((await f.library.openChapter(chapterId)).workId).toBe(
      imported.workId,
    );
    await store.removeRecord(record.id);
    expect((await f.previewMove(intent)).eligible).toBe(true);
  } finally {
    await f.close();
  }
});

it.each(["work", "destination"])(
  "does not race the %s work's context ownership or release someone else's admission",
  async (scope) => {
    const f = await chapterMoveFixture();
    const entered = createDeferred<void>(),
      release = createDeferred<void>();
    let blocking: Promise<void> | undefined;
    try {
      const { withLibraryContentEdit } =
        await import("../src/main/library/lock");
      const input = await f.commandMove();
      blocking = withLibraryContentEdit(
        [{ kind: "work-context", scope, access: "write" }],
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      await entered.promise;
      await expect(f.applyMove(input)).rejects.toThrow();
      expect(f.app.jobs.gate.activities).toHaveLength(1);
      release.resolve();
      await blocking;
      const saved = await f.applyMove(input);
      await f.recoverMove(saved.id, "undo");
      await f.assertMoveRestored();
      expect(f.app.jobs.gate.activities).toEqual([]);
    } finally {
      release.resolve();
      await blocking;
      await f.close();
    }
  },
);
