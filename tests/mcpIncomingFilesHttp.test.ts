import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { libraryImportHttpFixture } from "./mcpLibraryImportHttp.fixture";
import { receiveIncomingFile } from "./mcpIncomingFiles.fixture";

it("uses scoped OAuth HTTP byte delivery without private paths and keeps durable import separate from upload lifetime", async () => {
  const f = await libraryImportHttpFixture();
  try {
    const begin = {
      requestId: randomUUID(),
      filename: "HTTP 원고.png",
      bytes: f.bytes.length,
      sha256: createHash("sha256").update(f.bytes).digest("hex"),
    };
    expect(
      (await f.call("carrot_begin_file_upload", begin, f.read)).error.message,
    ).toBe("Unknown tool");
    expect(
      (
        await f.call("carrot_begin_file_upload", {
          ...begin,
          path: "C:/private.png",
        })
      ).error.code,
    ).toBe(-32602);
    const call = async (name: string, args: object) => {
      const result = await f.call(name, args);
      expect(result.result?.isError, JSON.stringify(result)).toBe(false);
      return result.result.structuredContent;
    };
    const uploaded = await receiveIncomingFile(call, f.bytes, begin.filename);
    expect(
      (
        await f.call(
          "carrot_get_file_upload",
          { uploadId: uploaded.uploadId },
          f.other,
        )
      ).result.structuredContent.error,
    ).toBe("not_found");
    expect(
      (
        await f.call("carrot_write_file_upload", {
          uploadId: uploaded.uploadId,
          offset: 0,
          data: "file://secret",
        })
      ).error.code,
    ).toBe(-32602);
    const prepared = await call("carrot_prepare_uploaded_import", {
      requestId: randomUUID(),
      source: "local",
      kind: "images",
      uploadId: uploaded.uploadId,
    });
    const done = await f.settle(prepared);
    expect(done.status).toBe("completed");
    const ref = done.result?.importPreview;
    if (!ref) throw new Error("Missing frozen input");
    const review = await call("carrot_get_import_preview", {
      previewId: ref.previewId,
      snapshot: ref.snapshot,
    });
    await call("carrot_discard_file_upload", { uploadId: uploaded.uploadId });
    const input = {
      requestId: randomUUID(),
      previewId: ref.previewId,
      snapshot: ref.snapshot,
      allowNativePreparation: true,
      target: { mode: "new", title: "Received through HTTP" },
      chapters: [
        {
          draftId: review.pages[0].draftId,
          title: "Uploaded page",
          pageIds: [review.pages[0].pageId],
        },
      ],
    };
    const imported = await f.settle(
      await call("carrot_import_chapters", input),
    );
    expect(imported.status).toBe("completed");
    const receipt = imported.result?.importReceipt;
    if (!receipt) throw new Error("Missing import receipt");
    const chapter = await f.library.openChapter(receipt.chapterIds[0]);
    expect(await readFile(chapter.pages[0].imagePath)).toEqual(f.bytes);
    await f.restart();
    expect(
      await call("carrot_get_import_receipt", { requestId: input.requestId }),
    ).toMatchObject(receipt);
    expect(f.choose).not.toHaveBeenCalled();
    expect(
      JSON.stringify({ uploaded, review, receipt, journal: f.journal() }),
    ).not.toMatch(
      /sourcePath|authorized-input|carrot-mcp-input|dataUrl|base64/,
    );
  } finally {
    await f.close();
  }
});
