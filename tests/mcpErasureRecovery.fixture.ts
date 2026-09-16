import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";
import { editingChapter } from "./mcpEditing.fixture";
import { createPageRevision } from "../src/shared/pageRevision";

/** Real library transactions and history/retention in an isolated data root. */
export async function recoveryLibrary(nativeImage?: unknown) {
  const environment = await mcpAppEnvironment(
    nativeImage ?? {
      createFromPath: () => ({
        getSize: () => ({ width: 1000, height: 1600 }),
      }),
    },
  );
  const root = environment.libraryDir;
  const chapterDir = join(root, "works", "work", "chapters", "chapter");
  await mkdir(join(chapterDir, "pages"), { recursive: true });
  await mkdir(join(chapterDir, "inpainted"));
  const original = join(chapterDir, "pages", "page.png");
  const output = join(chapterDir, "inpainted", "result.png");
  await writeFile(original, "original-pixels");
  await writeFile(output, "erased-pixels");
  const seeded = editingChapter();
  const page = {
    ...seeded.pages[0],
    imagePath: original,
    inpaintedImagePath: undefined,
    inpaintMaskPath: undefined,
    maskProvenance: undefined,
    dataUrl: undefined,
    blocks: seeded.pages[0].blocks.map((block) => ({
      ...block,
      generatedLettering: undefined,
      backgroundColor: "#ffffff",
    })),
  };
  const chapterPath = join(chapterDir, "chapter.json");
  const workPath = join(root, "works", "work", "work.json");
  await writeFile(
    join(root, "index.json"),
    JSON.stringify({ workOrder: ["work"] }),
  );
  await writeFile(
    workPath,
    JSON.stringify({
      id: "work",
      title: "test",
      chapterOrder: ["chapter"],
      createdAt: seeded.createdAt,
      updatedAt: seeded.updatedAt,
    }),
  );
  await writeFile(
    chapterPath,
    JSON.stringify({
      ...seeded,
      id: "chapter",
      workId: "work",
      pages: [page],
      pageOrder: [page.id],
    }),
  );
  const library = await import("../src/main/library");
  const { InpaintingRevisionStore } =
    await import("../src/main/inpainting/inpaintingRevisionStore");
  const store = new InpaintingRevisionStore();
  const target = {
    chapterId: "chapter",
    pageId: page.id,
    blockId: page.blocks[0].id,
  };
  const before = (await library.openChapter("chapter")).pages[0];
  const after = (
    await library.updatePagesAfterInpainting("chapter", [
      { ...before, inpaintedImagePath: output },
    ])
  ).pages[0];
  const transactionId = store.beginTransaction();
  store.addChange(transactionId, {
    ...target,
    beforeRevision: createPageRevision(before),
    afterRevision: createPageRevision(after),
    beforePath: before.inpaintedImagePath,
    afterPath: output,
  });
  const inspect = () =>
    store.inspectSinglePageTransaction(transactionId, target);
  const snapshot = async () => ({
    chapter: await readFile(chapterPath, "utf8"),
    work: await readFile(workPath, "utf8"),
    original: await readFile(original, "utf8"),
  });
  return {
    environment,
    library,
    store,
    target,
    before,
    after,
    output,
    original,
    chapterPath,
    transactionId,
    inspect,
    snapshot,
    async close() {
      try {
        await store.releaseAll();
      } finally {
        await environment.close();
      }
    },
  };
}
