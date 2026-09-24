import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { pageDeletionFixture } from "./mcpPageDeletion.fixture";
import { createDeferred } from "./inpaintingSelectionJobFixtures";
import { DEFAULT_RASTER_EXPORT_SETTINGS } from "../src/shared/linkedWorkspaceTypes";

it("preserves a sibling's shared original throughout page deletion and exact reconstructed recovery", async () => {
  const f = await pageDeletionFixture();
  try {
    const chapter = JSON.parse(await readFile(f.chapterPath, "utf8"));
    chapter.pages[1].imagePath = chapter.pages[0].imagePath;
    await writeFile(f.chapterPath, JSON.stringify(chapter));
    const bytes = await readFile(f.selected.imagePath),
      original = await f.capturePage();
    const saved = await f.applyPage(await f.commandPage());
    expect(await readFile(f.selected.imagePath)).toEqual(bytes);
    expect(
      (await f.library.openChapter(f.pageTarget.chapterId)).pages[0].imagePath,
    ).toBe(f.selected.imagePath);
    await f.restart();
    await f.recoverPage(saved.id, "undo");
    expect(await f.capturePage()).toEqual(original);
  } finally {
    await f.close();
  }
});

it("does not release another context activity when page deletion admission is rejected", async () => {
  const f = await pageDeletionFixture();
  const entered = createDeferred<void>(),
    release = createDeferred<void>();
  let pending: Promise<void> | undefined;
  try {
    const { withLibraryContentEdit } = await import("../src/main/library/lock");
    const input = await f.commandPage();
    pending = withLibraryContentEdit(
      [{ kind: "work-context", scope: "work", access: "write" }],
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    await expect(f.applyPage(input)).rejects.toThrow();
    expect(f.app.jobs.gate.activities).toHaveLength(1);
    await f.assertPageOriginal();
    release.resolve();
    await pending;
    const saved = await f.applyPage(input);
    await f.recoverPage(saved.id, "undo");
    await f.assertPageOriginal();
    expect(f.app.jobs.gate.activities).toEqual([]);
  } finally {
    release.resolve();
    await pending;
    await f.close();
  }
});

it("refuses page removal in a disabled linked workspace until explicitly detached", async () => {
  const f = await pageDeletionFixture();
  try {
    const imported = await f.create(await f.importCommand(await f.prepare()));
    const chapter = await f.library.openChapter(imported.chapterIds[0]);
    const target = {
      workId: imported.workId,
      chapterId: chapter.id,
      pageId: chapter.pages[0].id,
    };
    const review = await f.previewPage(target);
    const { LinkedWorkspaceStore } =
      await import("../src/main/linkedWorkspace/linkedWorkspaceStore");
    const store = new LinkedWorkspaceStore(f.app.appPaths.dataRoot);
    const link = {
      id: randomUUID(),
      workId: target.workId,
      chapterId: target.chapterId,
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
    await store.replaceRecord(link);
    await expect(f.previewPage(target)).rejects.toThrow(/linked workspace/);
    await expect(
      f.call("carrot_delete_page", {
        ...target,
        snapshot: review.snapshot,
        requestId: randomUUID(),
        confirm: "delete-page-with-seven-day-recovery",
      }),
    ).rejects.toThrow(/linked workspace/);
    expect((await store.readRegistry()).records).toEqual([link]);
    expect(await f.library.openChapter(chapter.id)).toEqual(chapter);
  } finally {
    await f.close();
  }
});
