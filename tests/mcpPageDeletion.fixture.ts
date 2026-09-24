import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { chapterDeletionFixture } from "./mcpChapterDeletion.fixture";
import {
  McpPageDeletionApplySchema,
  mcpPageDeletionOutputs,
} from "../src/shared/mcpPageDeletion";

export async function pageDeletionFixture(
  probeAvailable = true,
  withMemory = true,
) {
  const f = await chapterDeletionFixture(probeAvailable);
  const chapterPath = join(f.directory, "chapter.json");
  const chapter = JSON.parse(await readFile(chapterPath, "utf8"));
  const selected = chapter.pages[0];
  const siblingPath = join(f.directory, "pages", "sibling.png");
  await copyFile(selected.imagePath, siblingPath);
  const sibling = {
    ...selected,
    id: "sibling-page",
    name: "Sibling original",
    imagePath: siblingPath,
    inpaintedImagePath: undefined,
    inpaintMaskPath: undefined,
    translationCheckpoint: undefined,
  };
  chapter.pages = [selected, sibling];
  chapter.pageOrder = [selected.id, sibling.id];
  await writeFile(chapterPath, JSON.stringify(chapter));
  const runRoot = join(f.directory, "runs", "page-delete-test", "pages");
  const removedRun = join(runRoot, selected.id),
    siblingRun = join(runRoot, sibling.id);
  await mkdir(join(removedRun, "empty", "nested"), { recursive: true });
  await mkdir(siblingRun, { recursive: true });
  await writeFile(
    join(removedRun, "original.bin"),
    Buffer.from([0, 255, 0, 128]),
  );
  await writeFile(join(siblingRun, "kept.txt"), "Sibling run data");
  const memoryPath = join(f.directory, "story-memory.json");
  const row = (id: string, index: number) => ({
    pageId: id,
    pageName: "Old memory name",
    pageIndex: index,
    sourceDigest: "PRIVATE source",
    translatedDigest: "PRIVATE translation",
    summary: "PRIVATE manual summary",
    visualSummary: "PRIVATE manual scene",
    visualSummarySource: "manual",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  const memory = {
    schemaVersion: 1,
    workId: "work",
    chapterId: "chapter",
    updatedAt: "2026-09-01T00:00:00.000Z",
    pages: [
      row(selected.id, 3),
      row(sibling.id, 4),
      { ...row(sibling.id, 5), summary: "Last duplicate" },
      row("orphan", 6),
    ],
  };
  if (withMemory) await writeFile(memoryPath, JSON.stringify(memory));
  const workPath = join(f.env.libraryDir, "works", "work", "work.json");
  const capturePage = async () => ({
    tree: await f.files.captureChapterDeletionTree(f.directory, () => {}),
    work: JSON.parse(await readFile(workPath, "utf8")),
  });
  const originalPage = await capturePage();
  const originalMemory = withMemory ? await readFile(memoryPath) : null;
  const pageTarget = { ...f.target, pageId: selected.id };
  const previewPage = async (target = pageTarget) =>
    mcpPageDeletionOutputs.carrot_preview_page_deletion.parse(
      await f.call("carrot_preview_page_deletion", target),
    );
  const commandPage = async () =>
    McpPageDeletionApplySchema.parse({
      ...pageTarget,
      snapshot: (await previewPage()).snapshot,
      requestId: randomUUID(),
      confirm: "delete-page-with-seven-day-recovery",
    });
  const applyPage = async (
    input: Awaited<ReturnType<typeof commandPage>>,
    caller = f.auth(),
  ) =>
    mcpPageDeletionOutputs.carrot_delete_page.parse(
      await f.call("carrot_delete_page", input, caller),
    );
  const inspectPage = async (id: string) =>
    mcpPageDeletionOutputs.carrot_get_page_deletion.parse(
      await f.call("carrot_get_page_deletion", { id }),
    );
  const recoverPage = async (id: string, direction: "undo" | "redo") => {
    const input = {
      id,
      snapshot: (await inspectPage(id)).snapshot,
      requestId: randomUUID(),
      confirm: true,
    };
    return {
      input,
      receipt: mcpPageDeletionOutputs.carrot_undo_page_deletion.parse(
        await f.call(`carrot_${direction}_page_deletion`, input),
      ),
    };
  };
  return {
    ...f,
    pageTarget,
    selected,
    sibling,
    chapterPath,
    memoryPath,
    workPath,
    memory,
    originalMemory,
    removedRun,
    siblingRun,
    capturePage,
    originalPage,
    previewPage,
    commandPage,
    applyPage,
    inspectPage,
    recoverPage,
    assertPageOriginal: async () => {
      expect(await capturePage()).toEqual(originalPage);
      if (originalMemory)
        expect(await readFile(memoryPath)).toEqual(originalMemory);
      else
        await expect(readFile(memoryPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  };
}
