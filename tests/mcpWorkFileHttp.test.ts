import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { libraryImportHttpFixture } from "./mcpLibraryImportHttp.fixture";
import { receiveIncomingFile } from "./mcpIncomingFiles.fixture";
import { McpWorkFileCreateSchema } from "../src/shared/mcpWorkFileImport";

async function workFileHttpFixture() {
  const f = await libraryImportHttpFixture({
    shareImporter: async (request, signal, publication) => {
      const { importWorkShare } =
        await import("../src/main/library/libraryShareFacade");
      const { openSharePackageSession } =
        await import("../src/main/libraryStore/sharePackage");
      return importWorkShare(request, signal, publication, {
        openPackage: openSharePackageSession,
        image: {
          validateImageFile: async (path) => {
            PNG.sync.read(await readFile(path));
          },
          convertWebpToPngFile: async () => {
            throw new Error("PNG fixture");
          },
        },
      });
    },
  });
  const checked = async (name: string, args: object) => {
    const result = await f.call(name, args);
    expect(result.result?.isError, JSON.stringify(result)).toBe(false);
    return result.result.structuredContent;
  };
  return { ...f, checked };
}

it("uses scoped HTTP work-file tools with real native publication and no private paths or image-transfer permission", async () => {
  const f = await workFileHttpFixture();
  try {
    const path = join(f.env.root, "HTTP.mgtshare");
    await f.library.exportWorkShareToFile({
      workId: "work",
      chapterIds: ["chapter"],
      outputPath: path,
    });
    const call = f.checked;
    const upload = await receiveIncomingFile(
      call,
      await readFile(path),
      "HTTP.mgtshare",
    );
    const review = await call("carrot_preview_work_file", {
      uploadId: upload.uploadId,
    });
    const input = McpWorkFileCreateSchema.parse({
      requestId: randomUUID(),
      uploadId: upload.uploadId,
      snapshot: review.snapshot,
      target: { mode: "new", title: "HTTP editable" },
      chapters: [
        {
          packageChapterId: review.chapters[0].packageChapterId,
          title: "Imported",
        },
      ],
      allowNativePreparation: true,
      acknowledgeV1Limitations: true,
    });
    expect(
      (await f.call("carrot_import_work_file", input, f.read)).error.message,
    ).toBe("Unknown tool");
    expect(
      (
        await f.call(
          "carrot_preview_work_file",
          { uploadId: upload.uploadId },
          f.other,
        )
      ).result.structuredContent.error,
    ).toBe("not_found");
    expect(
      (await f.call("carrot_import_work_file", { ...input, rawPath: path }))
        .error.code,
    ).toBe(-32602);
    const done = await f.settle(await call("carrot_import_work_file", input));
    expect(done.status).toBe("completed");
    const receipt = done.result?.workFileReceipt;
    if (!receipt) throw new Error("Missing native receipt");
    expect(
      (await f.library.openChapter(receipt.chapterIds[0])).pages[0].blocks
        .length,
    ).toBe(2);
    await f.restart();
    expect(
      await call("carrot_get_work_file_import", { requestId: input.requestId }),
    ).toEqual(receipt);
    expect(
      (await f.settle(await call("carrot_import_work_file", input))).result
        ?.workFileReceipt,
    ).toEqual(receipt);
    expect(
      JSON.stringify({ review, receipt, journal: f.journal() }),
    ).not.toMatch(/imagePath|sourcePath|carrot-mcp-input|dataUrl|base64/);
    expect(f.choose).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("requires scoped ownership and a reviewed append target across actual OAuth HTTP requests", async () => {
  const f = await workFileHttpFixture();
  try {
    const path = join(f.env.root, "Append.mgtshare");
    await f.library.exportWorkShareToFile({
      workId: "work",
      chapterIds: ["chapter"],
      outputPath: path,
    });
    const before = await f.library.openChapter("chapter");
    const library = await f.library.listLibrary();
    const upload = await receiveIncomingFile(
      f.checked,
      await readFile(path),
      "Append.mgtshare",
    );
    const source = await f.checked("carrot_preview_work_file", {
      uploadId: upload.uploadId,
    });
    const input = {
      uploadId: upload.uploadId,
      snapshot: source.snapshot,
      chapters: [
        {
          packageChapterId: source.chapters[0].packageChapterId,
          title: "Appended",
        },
      ],
      target: { workId: "work", contextPolicy: "preserve-destination" },
    };
    const review = await f.checked("carrot_preview_work_file_append", input);
    expect(review.eligible).toBe(true);
    expect(
      (await f.call("carrot_preview_work_file_append", input, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    const command = McpWorkFileCreateSchema.parse({
      ...input,
      target: review.target,
      requestId: randomUUID(),
      allowNativePreparation: true,
      acknowledgeV1Limitations: true,
    });
    expect(
      (await f.call("carrot_import_work_file", command, f.read)).error.message,
    ).toBe("Unknown tool");
    expect(
      (
        await f.call("carrot_preview_work_file_append", {
          ...input,
          packagePath: path,
        })
      ).error.code,
    ).toBe(-32602);
    const done = await f.settle(
      await f.checked("carrot_import_work_file", command),
    );
    expect(done.status).toBe("completed");
    const receipt = done.result?.workFileReceipt;
    if (!receipt) throw new Error("Missing append receipt");
    expect(receipt.workId).toBe("work");
    expect(await f.library.openChapter("chapter")).toEqual(before);
    expect((await f.library.listLibrary()).works).toHaveLength(
      library.works.length,
    );
    await f.checked("carrot_discard_file_upload", {
      uploadId: upload.uploadId,
    });
    await f.restart();
    expect(
      (await f.settle(await f.checked("carrot_import_work_file", command)))
        .result?.workFileReceipt,
    ).toEqual(receipt);
    expect(await f.library.openChapter("chapter")).toEqual(before);
    expect(
      JSON.stringify({ review, receipt, journal: f.journal() }),
    ).not.toMatch(/imagePath|sourcePath|carrot-mcp-input|dataUrl|base64/);
    expect(f.choose).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
