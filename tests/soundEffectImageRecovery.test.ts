import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import type { SoundEffectTranslationJobInput } from "../src/main/jobs/translationJobTypes";
import type { SoundEffectImageRecoveryDependencies } from "../src/main/jobs/soundEffectImageRecoveryRunner";
import { createPageRevision } from "../src/shared/pageRevision";
import { makeBlock, makeChapter } from "./unifiedInpaintingUiFixtures";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
const roots: string[] = [];
const runId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
afterEach(async () => {
  vi.resetModules();
  vi.doUnmock("../src/main/appPaths");
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sfx-recovery-"));
  roots.push(root);
  vi.resetModules();
  vi.doMock("../src/main/appPaths", () => ({
    getAppPaths: () => ({ libraryDir: root, logFile: join(root, "app.log") }),
  }));
  const chapter = makeChapter();
  const directory = join(root, "works", chapter.workId, "chapters", chapter.id);
  await mkdir(directory, { recursive: true });
  const original = join(directory, "original.png");
  const generated = join(directory, "generated.png");
  const bytes = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  await writeFile(original, bytes);
  await writeFile(generated, bytes);
  chapter.pages = [0, 1].map((i) => ({
    ...chapter.pages[0],
    id: `page-${i}`,
    imagePath: original,
    blocks: [
      {
        ...makeBlock(),
        id: `page-${i}-${runId}-sfx-block-1`,
        translatedText: `確定${i}`,
      },
      { ...makeBlock(), id: `other-${i}`, translatedText: "unrelated" },
    ],
  }));
  chapter.pageOrder = chapter.pages.map((page) => page.id);
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({ workOrder: [chapter.workId] }),
  );
  await writeFile(
    join(root, "works", chapter.workId, "work.json"),
    JSON.stringify({
      id: chapter.workId,
      title: "fixture",
      chapterOrder: [chapter.id],
      createdAt: chapter.createdAt,
      updatedAt: chapter.updatedAt,
    }),
  );
  const chapterPath = join(directory, "chapter.json");
  await writeFile(
    chapterPath,
    JSON.stringify({
      ...chapter,
      pages: chapter.pages.map(({ dataUrl: _data, ...page }) => page),
    }),
  );
  const library = await import("../src/main/library");
  const store = await import("../src/main/soundEffectImageRecoveryStore");
  const images = await import("../src/main/codexImageEditing");
  const runner =
    await import("../src/main/jobs/soundEffectImageRecoveryRunner");
  const { ActiveJobStore } = await import("../src/main/jobs/activeJob");
  const stored = await library.openChapter(chapter.id);
  const plan = {
    version: 1 as const,
    runId,
    chapterId: chapter.id,
    eraseOriginal: true,
    output: "image" as const,
    pages: stored.pages.map((page) => ({
      pageId: page.id,
      revision: createPageRevision(page),
      blockIds: [page.blocks[0].id],
      reading: images.translatedPageReading(
        { ...page, blocks: [page.blocks[0]] },
        "image",
      ),
      erasedBlockIds: [] as string[],
      completed: false,
    })),
  };
  const input: SoundEffectTranslationJobInput = {
    id: runId,
    context: {
      jobs: new ActiveJobStore(),
      getMainWindow: () => null,
      decodeImage: async () => null,
    },
    request: {
      chapterId: chapter.id,
      targets: [],
      inpaintAfterTranslation: true,
    },
    abortController: new AbortController(),
    emit: vi.fn(),
    registerResourceCleanup: () => {},
    state: {
      chapter: stored,
      createdBlocksByPage: [],
      translatedRegionCount: 0,
      warnings: [],
    },
  };
  const editImages = vi.fn<SoundEffectImageRecoveryDependencies["editImages"]>(
    async ({ page }) => ({ ...page, inpaintedImagePath: generated }),
  );
  const dependencies = {
    editImages,
    openChapter: library.openChapter,
    saveImages: library.updatePagesAfterInpainting,
    getRunPaths: library.getRunPaths,
    saveRecovery: store.saveSoundEffectImageRecovery,
  };
  return {
    directory,
    chapterPath,
    generated,
    chapter: stored,
    plan,
    input,
    store,
    images,
    runner,
    dependencies,
    editImages,
  };
}

it("checkpoints a failed page, continues others, and reloads only unfinished images after restart", async () => {
  const f = await fixture();
  f.editImages.mockImplementationOnce(async ({ page, onCheckpoint }) => {
    const erased = { ...page, inpaintedImagePath: f.generated };
    await onCheckpoint?.(erased, page.blocks[0].id);
    throw new f.images.CodexImageEditError(
      erased,
      new Error("bad generated dimensions"),
    );
  });
  expect(
    await f.runner.runSoundEffectImageRecovery(f.input, f.plan, f.dependencies),
  ).toHaveLength(1);
  expect(f.editImages).toHaveBeenCalledTimes(2);
  expect(f.plan.pages.map((page) => page.completed)).toEqual([false, true]);
  const completedEvents = vi
    .mocked(f.input.emit)
    .mock.calls.map(([event]) => event)
    .filter((event) => event.phase === "page_done");
  expect(completedEvents.map((event) => event.pageIndex)).toEqual([1, 2]);
  expect(completedEvents.map((event) => event.progressCurrent)).toEqual([1, 2]);
  expect(
    completedEvents.map((event) => event.codexProgress?.completed),
  ).toEqual([1, 2]);
  const saved = await f.dependencies.openChapter(f.chapter.id);
  expect(
    saved.pages.every((page) => page.inpaintedImagePath === f.generated),
  ).toBe(true);
  expect(
    saved.pages.map((page) => page.blocks.map((block) => block.translatedText)),
  ).toEqual(
    f.chapter.pages.map((page) =>
      page.blocks.map((block) => block.translatedText),
    ),
  );
  const recovery = await f.store.getSoundEffectImageRecovery(saved.id);
  expect(recovery?.targets.map((page) => page.pageId)).toEqual([
    saved.pages[0].id,
  ]);
  const reloaded = await f.store.loadSoundEffectImageRecovery(saved, runId);
  if (!reloaded) throw new Error("Missing durable checkpoint");
  f.editImages.mockClear();
  await f.runner.runSoundEffectImageRecovery(f.input, reloaded, f.dependencies);
  expect(f.editImages).toHaveBeenCalledOnce();
  expect(f.editImages.mock.calls[0][0].erasedBlockIds).toEqual([
    saved.pages[0].blocks[0].id,
  ]);
  expect(await f.store.getSoundEffectImageRecovery(saved.id)).toBeNull();
});

it.each(["cancel", "storage", "stale"])(
  "stops safely on %s without applying later pages",
  async (failure) => {
    const f = await fixture();
    const before = await readFile(f.chapterPath, "utf8");
    if (failure === "stale")
      f.plan.pages[0].revision = "page-v1:0000000000000000";
    else
      f.editImages.mockImplementation(async ({ page }) => {
        if (failure === "cancel") {
          f.input.abortController.abort();
          return { ...page, inpaintedImagePath: f.generated };
        }
        const { ImageCheckpointError } =
          await import("../src/main/pipeline/imageJobFailure");
        throw new ImageCheckpointError(new Error("disk full"));
      });
    await expect(
      f.runner.runSoundEffectImageRecovery(f.input, f.plan, f.dependencies),
    ).rejects.toThrow();
    expect(f.editImages).toHaveBeenCalledTimes(failure === "stale" ? 0 : 1);
    expect(await readFile(f.chapterPath, "utf8")).toBe(before);
    expect(f.plan.pages.every((page) => !page.completed)).toBe(true);
  },
);

it("recovers legacy approved blocks only after evidence of an attempted ImageGen call", async () => {
  const f = await fixture();
  expect(await f.store.getSoundEffectImageRecovery(f.chapter.id)).toBeNull();
  const images = join(
    f.directory,
    "runs",
    runId,
    "codex-image",
    f.chapter.pages[0].id,
  );
  await mkdir(images, { recursive: true });
  await writeFile(
    join(images, "image-call-exec-attempt.json"),
    JSON.stringify({ purpose: "background" }),
  );
  const recovery = await f.store.getSoundEffectImageRecovery(f.chapter.id);
  expect(recovery).toMatchObject({
    runId,
    blockCount: 2,
    eraseOriginal: true,
    output: "image",
  });
  const plan = await f.store.loadSoundEffectImageRecovery(f.chapter, runId);
  expect(plan?.pages[0].reading.regions[0].translatedText).toBe("確定0");
  await expect(
    f.store.loadSoundEffectImageRecovery(f.chapter, "../../elsewhere"),
  ).rejects.toThrow("ID");
  await f.store.saveSoundEffectImageRecovery(f.plan);
  await writeFile(
    join(f.directory, "runs", runId, "sound-effect-image-recovery.json"),
    JSON.stringify({ ...f.plan, pages: [{}] }),
  );
  await expect(
    f.store.loadSoundEffectImageRecovery(f.chapter, runId),
  ).rejects.toThrow("기록");
});
