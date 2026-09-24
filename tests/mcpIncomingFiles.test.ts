import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ZipFile } from "yazl";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import {
  receiveIncomingFile,
  prepareIncomingFile,
} from "./mcpIncomingFiles.fixture";

it("uploads without a local picker, freezes selection, disposes input and imports with durable replay and source history", async () => {
  const f = await libraryImportFixture();
  try {
    const original = await f.library.listLibrary();
    const receipt = await receiveIncomingFile(f.invoke, f.bytes);
    expect(receipt).toMatchObject({
      status: "ready",
      importable: "not-yet-checked",
    });
    expect(await f.library.listLibrary()).toEqual(original);
    const prepared = await prepareIncomingFile(f, receipt.uploadId);
    const review = await f.inspect(prepared.ref);
    expect(review.pages[0].name).toBe("받은 원고.png");
    expect(f.choose).not.toHaveBeenCalled();
    expect(
      await f.invoke("carrot_prepare_uploaded_import", prepared.input),
    ).toMatchObject({ jobId: (prepared.accepted as { jobId: string }).jobId });
    await f.invoke("carrot_discard_file_upload", {
      uploadId: receipt.uploadId,
    });
    const command = await f.command(prepared.ref),
      saved = await f.create(command);
    const chapter = await f.library.openChapter(saved.chapterIds[0]);
    expect(await readFile(chapter.pages[0].imagePath)).toEqual(f.bytes);
    expect(chapter.importSource).toBeDefined();
    await f.restart();
    expect(await f.create(command)).toEqual(saved);
    await expect(
      f.invoke("carrot_get_file_upload", { uploadId: receipt.uploadId }),
    ).rejects.toThrow();
    expect(await readFile(f.originals[0])).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});
it("prepares only selected ZIP images and preserves the requested page order and exact file contents", async () => {
  const f = await libraryImportFixture();
  try {
    const zip = new ZipFile(),
      chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      zip.outputStream.on("data", (chunk) => chunks.push(chunk));
      zip.outputStream.once("error", reject);
      zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
    });
    zip.addBuffer(f.bytes, "first.png");
    const second = await readFile(f.originals[1]);
    zip.addBuffer(second, "second.png");
    zip.end();
    const receipt = await receiveIncomingFile(
      f.invoke,
      await done,
      "two chapters.cbz",
    );
    const { ref } = await prepareIncomingFile(f, receipt.uploadId, "archive");
    const review = await f.inspect(ref),
      command = await f.command(ref);
    command.chapters[0].pageIds = [review.pages[1].pageId];
    const saved = await f.create(command),
      chapter = await f.library.openChapter(saved.chapterIds[0]);
    expect(chapter.pages).toHaveLength(1);
    expect(await readFile(chapter.pages[0].imagePath)).toEqual(second);
    expect(f.choose).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it.each([
  ["wrong.png", "images"],
  ["broken.zip", "archive"],
  ["unprepared.pdf", "pdf"],
  ["unprepared.rar", "archive"],
] as const)(
  "does not mistake byte verification for importability or native preparation permission: %s",
  async (filename, kind) => {
    const f = await libraryImportFixture();
    try {
      const original = await f.library.listLibrary();
      const receipt = await receiveIncomingFile(
        f.invoke,
        Buffer.from("not an importable document"),
        filename,
      );
      const accepted = await f.invoke("carrot_prepare_uploaded_import", {
        requestId: randomUUID(),
        source: "local",
        uploadId: receipt.uploadId,
        kind,
      });
      expect((await f.settle(accepted)).status).toBe("failed");
      expect(await f.library.listLibrary()).toEqual(original);
      expect((await f.storage.index()).entries).toEqual([]);
      expect(f.choose).not.toHaveBeenCalled();
      await f.invoke("carrot_discard_file_upload", {
        uploadId: receipt.uploadId,
      });
    } finally {
      await f.close();
    }
  },
);
it("keeps new preview duplicate checks after previous uploads are discarded", async () => {
  const f = await libraryImportFixture();
  try {
    const first = await receiveIncomingFile(f.invoke, f.bytes),
      prepared = await prepareIncomingFile(f, first.uploadId);
    const saved = await f.create(await f.command(prepared.ref));
    await f.invoke("carrot_discard_file_upload", { uploadId: first.uploadId });
    const second = await receiveIncomingFile(f.invoke, f.bytes, "renamed.png"),
      next = await prepareIncomingFile(f, second.uploadId);
    const command = await f.command(next.ref);
    const target = (await f.invoke("carrot_get_import_target", {
      workId: saved.workId,
    })) as { snapshot: string };
    command.target = {
      mode: "existing",
      workId: saved.workId,
      snapshot: target.snapshot,
    };
    command.duplicatePolicy = "reject-known";
    const accepted = await f.invoke("carrot_import_chapters", command);
    expect((await f.settle(accepted)).status).toBe("failed");
    const work = (await f.library.listLibrary()).works.find(
      (item) => item.id === saved.workId,
    );
    expect(work?.chapters).toHaveLength(1);
    expect(
      await readFile(join(f.env.root, "authorized-input", "first.png")),
    ).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});
