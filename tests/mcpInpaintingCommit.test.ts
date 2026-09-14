import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { mcpAppEnvironment } from "./mcpAppEnvironment.fixture";
import { createPageJobTargetSnapshot } from "../src/shared/pageRevision";

it("rolls back the actual inpainting chapter/work transaction when authority is revoked at commit", async () => {
  const environment = await mcpAppEnvironment({
    createFromPath: () => ({ getSize: () => ({ width: 64, height: 96 }) }),
  });
  const root = environment.libraryDir;
  const chapterDir = join(root, "works", "work", "chapters", "chapter");
  await mkdir(join(chapterDir, "pages"), { recursive: true });
  await mkdir(join(chapterDir, "inpainted"));
  const imagePath = join(chapterDir, "pages", "page.png");
  const output = join(chapterDir, "inpainted", "result.png");
  await writeFile(imagePath, "original");
  await writeFile(output, "generated-output");
  const date = "2026-01-01T00:00:00.000Z";
  const page = {
    id: "page",
    name: "page.png",
    imagePath,
    width: 64,
    height: 96,
    blocks: [],
    analysisStatus: "idle",
    createdAt: date,
    updatedAt: date,
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
      createdAt: date,
      updatedAt: date,
    }),
  );
  await writeFile(
    chapterPath,
    JSON.stringify({
      id: "chapter",
      workId: "work",
      title: "test",
      sourceKind: "images",
      status: "idle",
      pageOrder: ["page"],
      pages: [page],
      createdAt: date,
      updatedAt: date,
    }),
  );
  const library = await import("../src/main/library");
  const { setLibraryTransactionCrashInjectorForTests } =
    await import("../src/main/libraryStore/libraryTransaction");
  let allowed = true;
  const reset = setLibraryTransactionCrashInjectorForTests((point) => {
    if (point === "before-commit-point") allowed = false;
  });
  try {
    const before = await readFile(chapterPath, "utf8");
    const workBefore = await readFile(workPath, "utf8");
    const chapter = await library.openChapter("chapter");
    const stored = chapter.pages[0];
    await expect(
      library.updatePagesAfterInpainting(
        "chapter",
        [{ ...stored, inpaintedImagePath: output }],
        { expectedTargets: [createPageJobTargetSnapshot("chapter", stored)] },
        () => {
          if (!allowed) throw new Error("authorization revoked");
        },
      ),
    ).rejects.toThrow("authorization revoked");
    expect(await readFile(chapterPath, "utf8")).toBe(before);
    expect(await readFile(workPath, "utf8")).toBe(workBefore);
    expect(await readFile(imagePath, "utf8")).toBe("original");
  } finally {
    reset();
    await environment.close();
  }
});
