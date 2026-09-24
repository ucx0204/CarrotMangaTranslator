import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import AdmZip from "adm-zip";
import { PNG } from "pngjs";
import { expect, it, vi } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { McpImportPreviewReferenceSchema } from "../src/shared/mcpLibraryImport";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../src/shared/pageRevision";

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

it("records exactly the reviewed page order at native publication and recovers the same mapping after restart", async () => {
  const f = await libraryImportFixture();
  try {
    const input = await f.command(await f.prepare());
    input.chapters[0].pageIds.reverse();
    const before = await f.library.listLibrary();
    const review = await f
      .current()
      .session.reviewMapping("import-owner", input, () => {});
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.validate).not.toHaveBeenCalled();
    await expect(
      f.current().session.reviewMapping("other", input, () => {}),
    ).rejects.toMatchObject({ code: "not_found" });
    const receipt = await f.create(input);
    const mapping = receipt.pageMapping;
    if (!mapping)
      throw new Error("Native import did not retain exact page evidence");
    const saved = await f.library.openChapter(receipt.chapterIds[0]);
    const chapterPath = join(
      f.env.libraryDir,
      "works",
      receipt.workId,
      "chapters",
      receipt.chapterIds[0],
      "chapter.json",
    );
    expect(mapping.publication).toEqual({
      workId: receipt.workId,
      workSha256: sha256(
        await readFile(
          join(f.env.libraryDir, "works", receipt.workId, "work.json"),
        ),
      ),
      guideSha256: null,
      chapters: [
        {
          chapterId: receipt.chapterIds[0],
          sha256: sha256(await readFile(chapterPath)),
          memorySha256: null,
        },
      ],
    });
    if (!mapping.publication)
      throw new Error("Native import did not retain publication metadata");
    const { verifyNativeImportPublicationMetadata } =
      await import("../src/main/libraryStore/importPublicationMetadata");
    await verifyNativeImportPublicationMetadata(mapping.publication, () => {});
    expect(mapping.selectionFingerprint).toBe(review.selectionFingerprint);
    expect(mapping.items.map((item) => item.itemKey)).toEqual(review.itemKeys);
    expect(mapping.items.map((item) => item.page.pageId)).toEqual(
      saved.pages.map((page) => page.id),
    );
    expect(saved.pages.map((page) => page.name)).toEqual([
      "second.png",
      "first.png",
    ]);
    for (const [index, item] of mapping.items.entries()) {
      const source = await readFile(f.originals[1 - index]);
      expect(item.source).toEqual({
        bytes: source.length,
        sha256: sha256(source),
        format: "png",
      });
      expect(item.original).toEqual(item.source);
      expect(item.page).toMatchObject({
        workId: receipt.workId,
        chapterId: receipt.chapterIds[0],
        revision: createPageRevision(saved.pages[index]),
        reviewRevision: createSoundEffectReviewPageRevision(saved.pages[index]),
        blockCount: 0,
        blockIdsSha256: sha256("[]"),
      });
    }
    expect(JSON.stringify(mapping)).not.toContain(f.env.root);
    await f.restart();
    const recovered = await f.invoke("carrot_get_import_receipt", {
      requestId: input.requestId,
    });
    expect(recovered).toMatchObject({ pageMapping: mapping });
    expect(await f.create(input)).toEqual(receipt);
    expect(f.validate).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

it.each(["work", "chapter", "guide", "memory"] as const)(
  "rolls back native publication when staged %s metadata changes during receipt encryption",
  async (kind) => {
    const f = await libraryImportFixture();
    let restore = () => {};
    try {
      const input = await f.command(await f.prepare());
      const before = await f.library.listLibrary();
      const seal = f.codec.seal.bind(f.codec);
      const spy = vi
        .spyOn(f.codec, "seal")
        .mockImplementation(async (value) => {
          const result = await seal(value);
          if (value && typeof value === "object" && "receipt" in value) {
            const chapterDirectory = dirname(
              dirname(f.validate.mock.calls[0][0]),
            );
            if (kind === "chapter" || kind === "work") {
              const path =
                kind === "chapter"
                  ? join(chapterDirectory, "chapter.json")
                  : join(dirname(dirname(chapterDirectory)), "work.json");
              const metadata = JSON.parse(await readFile(path, "utf8"));
              await writeFile(
                path,
                JSON.stringify({
                  ...metadata,
                  title: "Changed after native observation",
                }),
              );
            } else {
              const path =
                kind === "guide"
                  ? join(dirname(dirname(chapterDirectory)), "style-guide.json")
                  : join(chapterDirectory, "story-memory.json");
              await writeFile(
                path,
                JSON.stringify({ changedAfterObservation: true }),
              );
            }
          }
          return result;
        });
      restore = () => spy.mockRestore();
      const done = await f.settle(
        await f.invoke("carrot_import_chapters", input),
      );
      restore();
      expect(done.status).toBe("failed");
      expect(await f.library.listLibrary()).toEqual(before);
      expect((await f.storage.index()).entries).toEqual([]);
      expect(await readFile(f.originals[0])).toEqual(f.bytes);
    } finally {
      restore();
      await f.close();
    }
  },
);

it("maps selected ZIP entry bytes instead of container bytes or later chapter ordering", async () => {
  const f = await libraryImportFixture();
  try {
    const path = join(f.env.root, "selection.zip");
    const first = await readFile(f.originals[0]);
    const second = await readFile(f.originals[1]);
    const zip = new AdmZip();
    zip.addFile("01.png", first);
    zip.addFile("02.png", second);
    zip.addFile("03.png", first);
    zip.addFile("ignored.txt", Buffer.from("not selected artwork"));
    await writeFile(path, zip.toBuffer());
    const archive = await readFile(path);
    f.choose.mockResolvedValueOnce([path]);
    const done = await f.settle(
      await f.invoke("carrot_choose_import_files", {
        source: "local",
        kind: "archive",
        requestId: randomUUID(),
      }),
    );
    expect(done.status).toBe("completed");
    const input = await f.command(
      McpImportPreviewReferenceSchema.parse(done.result?.importPreview),
    );
    input.chapters[0].pageIds = input.chapters[0].pageIds.slice(0, 2).reverse();
    const review = await f
      .current()
      .session.reviewMapping("import-owner", input, () => {});
    const receipt = await f.create(input);
    expect(receipt.pageMapping?.items.map((item) => item.itemKey)).toEqual(
      review.itemKeys,
    );
    expect(
      receipt.pageMapping?.items.map((item) => item.source.sha256),
    ).toEqual([sha256(second), sha256(first)]);
    expect(
      receipt.pageMapping?.items.some(
        (item) => item.source.sha256 === sha256(archive),
      ),
    ).toBe(false);
    expect(await readFile(path)).toEqual(archive);
  } finally {
    await f.close();
  }
});

it("keeps original WebP evidence distinct from the validated native PNG working original", async () => {
  const webp = Buffer.from(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
    "base64",
  );
  const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const f = await libraryImportFixture({
    importer: async (request, signal, publication) => {
      const { createLibraryImportService } =
        await import("../src/main/library/libraryImportFacade");
      const { withLibraryMutation } = await import("../src/main/library/lock");
      return createLibraryImportService({
        runMutation: withLibraryMutation,
        image: {
          validateImageFile: async (path) => {
            PNG.sync.read(await readFile(path));
          },
          // Existing expensive decoder boundary only; materialization and transactions remain native.
          convertWebpToPngFile: async (_source, output) => {
            await writeFile(output, png);
          },
        },
      }).createImport(request, signal, publication);
    },
  });
  try {
    const path = join(f.env.root, "actual.webp");
    await writeFile(path, webp);
    f.choose.mockResolvedValueOnce([path]);
    const input = await f.command(await f.prepare());
    const review = await f
      .current()
      .session.reviewMapping("import-owner", input, () => {});
    const receipt = await f.create(input);
    const item = receipt.pageMapping?.items[0];
    expect(item?.itemKey).toBe(review.itemKeys[0]);
    expect(item?.source).toEqual({
      bytes: webp.length,
      sha256: sha256(webp),
      format: "webp",
    });
    expect(item?.original).toEqual({
      bytes: png.length,
      sha256: sha256(png),
      format: "png",
    });
    const saved = await f.library.openChapter(receipt.chapterIds[0]);
    expect(await readFile(saved.pages[0].imagePath)).toEqual(png);
    expect(await readFile(path)).toEqual(webp);
  } finally {
    await f.close();
  }
});

it("rolls back chapter and encrypted mapping when staged original bytes change during receipt encryption", async () => {
  const f = await libraryImportFixture();
  let restore = () => {};
  try {
    const input = await f.command(await f.prepare());
    const before = await f.library.listLibrary();
    const seal = f.codec.seal.bind(f.codec);
    const spy = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const result = await seal(value);
      if (value && typeof value === "object" && "receipt" in value)
        await writeFile(
          f.validate.mock.calls[0][0],
          await readFile(f.originals[1]),
        );
      return result;
    });
    restore = () => spy.mockRestore();
    const done = await f.settle(
      await f.invoke("carrot_import_chapters", input),
    );
    restore();
    expect(done.status).toBe("failed");
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(await readFile(f.originals[0])).toEqual(f.bytes);
  } finally {
    restore();
    await f.close();
  }
});
