import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { vi } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { receiveIncomingFile } from "./mcpIncomingFiles.fixture";
import type { LibraryChapter } from "../src/shared/libraryTypes";
import {
  McpWorkFileCreateSchema,
  McpWorkFileReviewOutputSchema,
  McpWorkFileReceiptSchema,
  type McpWorkFileCreate,
} from "../src/shared/mcpWorkFileImport";

type Boundary = {
  beforeImage?: () => Promise<void>;
  sourcePath?: string;
};
export async function workFileFixture() {
  const boundary: Boundary = {};
  const validate = vi.fn(async (path: string) => {
    await boundary.beforeImage?.();
    PNG.sync.read(await readFile(path));
  });
  const f = await libraryImportFixture({
    shareImporter: async (request, signal, publication) => {
      boundary.sourcePath = request.packagePath;
      const { importWorkShare } =
        await import("../src/main/library/libraryShareFacade");
      const { openSharePackageSession } =
        await import("../src/main/libraryStore/sharePackage");
      return importWorkShare(request, signal, publication, {
        openPackage: openSharePackageSession,
        image: {
          validateImageFile: validate,
          convertWebpToPngFile: async () => {
            throw new Error("PNG-only fixture");
          },
        },
      });
    },
  });
  const seeded = await seedWorkFile(f);
  return {
    ...f,
    ...seeded,
    ...workFileCommands(f, seeded.packageBytes),
    boundary,
    validateShare: validate,
  };
}
async function seedWorkFile(
  f: Awaited<ReturnType<typeof libraryImportFixture>>,
) {
  const source: LibraryChapter = JSON.parse(
    await readFile(f.chapterPath, "utf8"),
  );
  source.pages[0].blockOrder = source.pages[0].blocks
    .map((block) => block.id)
    .reverse();
  const directory = join(dirname(f.chapterPath), "inpainted");
  await mkdir(directory);
  const processed = join(directory, "processed.png");
  await writeFile(processed, await readFile(f.originals[1]));
  source.pages[0].inpaintedImagePath = processed;
  await writeFile(f.chapterPath, JSON.stringify(source));
  const packagePath = join(f.env.root, "editable.mgtshare");
  await f.library.exportWorkShareToFile({
    workId: "work",
    chapterIds: ["chapter"],
    outputPath: packagePath,
  });
  return {
    packagePath,
    packageBytes: await readFile(packagePath),
    originalChapter: source,
  };
}
function workFileCommands(
  f: Awaited<ReturnType<typeof libraryImportFixture>>,
  bytes: Buffer,
) {
  const upload = async (data = bytes, filename = "editable.mgtshare") =>
    receiveIncomingFile(f.invoke, data, filename);
  const review = async (uploadId: string) =>
    McpWorkFileReviewOutputSchema.parse(
      await f.invoke("carrot_preview_work_file", { uploadId }),
    );
  const prepareWorkFile = async () => {
    const uploaded = await upload();
    const view = await review(uploaded.uploadId);
    const command = McpWorkFileCreateSchema.parse({
      requestId: randomUUID(),
      uploadId: uploaded.uploadId,
      snapshot: view.snapshot,
      target: { mode: "new", title: "Editable work" },
      chapters: view.chapters.map((chapter) => ({
        packageChapterId: chapter.packageChapterId,
        title: chapter.title,
      })),
      allowNativePreparation: true,
      acknowledgeV1Limitations: true,
    });
    return { uploaded, view, command };
  };
  const createWorkFile = async (command: McpWorkFileCreate) => {
    const result = await f.settle(
      await f.invoke("carrot_import_work_file", command),
    );
    if (result.status !== "completed")
      throw new Error(JSON.stringify({ result, errors: f.errors.map(String) }));
    return McpWorkFileReceiptSchema.parse(result.result?.workFileReceipt);
  };
  return { upload, review, prepareWorkFile, createWorkFile };
}
