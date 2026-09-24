import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { workFileFixture } from "./mcpWorkFileImport.fixture";
import { workFileAppendFixture } from "./mcpWorkFileAppend.fixture";
import { McpWorkFileCreateSchema } from "../src/shared/mcpWorkFileImport";
import {
  createPageRevision,
  createSoundEffectReviewPageRevision,
} from "../src/shared/pageRevision";
import type { LibraryChapter, LibraryWork } from "../src/shared/libraryTypes";

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

it("binds native package pageOrder and every remapped block identity without a 100-block truncation", async () => {
  const f = await workFileFixture();
  try {
    const source: LibraryChapter = JSON.parse(
      await readFile(f.chapterPath, "utf8"),
    );
    const first = structuredClone(source.pages[0]);
    first.blocks = Array.from({ length: 101 }, (_, index) => ({
      ...first.blocks[0],
      id: `source-block-${index}`,
      sourceText: "private mapping fixture text",
    }));
    delete first.blockOrder;
    delete first.translationCompletion;
    const second = {
      ...structuredClone(first),
      id: "second-source-page",
      name: "Second source page",
    };
    source.pages = [first, second];
    source.pageOrder = [second.id, first.id];
    await writeFile(f.chapterPath, JSON.stringify(source));
    const packagePath = join(f.env.root, "ordered-mapping.mgtshare");
    await f.library.exportWorkShareToFile({
      workId: "work",
      chapterIds: ["chapter"],
      outputPath: packagePath,
    });
    const bytes = await readFile(packagePath);
    const uploaded = await f.upload(bytes);
    const view = await f.review(uploaded.uploadId);
    const input = McpWorkFileCreateSchema.parse({
      requestId: randomUUID(),
      uploadId: uploaded.uploadId,
      snapshot: view.snapshot,
      target: { mode: "new", title: "Exact native mapping" },
      chapters: view.chapters.map(({ packageChapterId, title }) => ({
        packageChapterId,
        title,
      })),
      allowNativePreparation: true,
      acknowledgeV1Limitations: true,
    });
    const before = await f.library.listLibrary();
    const review = await f
      .current()
      .session.workFileReviewMapping("import-owner", input, () => {});
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.validateShare).not.toHaveBeenCalled();
    await expect(
      Promise.resolve().then(() =>
        f.current().session.workFileReviewMapping("other", input, () => {}),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const receipt = await f.createWorkFile(input);
    const mapping = receipt.pageMapping;
    if (!mapping)
      throw new Error("Native workfile did not retain exact page evidence");
    const saved = await f.library.openChapter(receipt.chapterIds[0]);
    const workDirectory = join(f.env.libraryDir, "works", receipt.workId);
    expect(mapping.publication).toEqual({
      workId: receipt.workId,
      workSha256: sha256(await readFile(join(workDirectory, "work.json"))),
      guideSha256: sha256(
        await readFile(join(workDirectory, "style-guide.json")),
      ),
      chapters: [
        {
          chapterId: saved.id,
          sha256: sha256(
            await readFile(
              join(workDirectory, "chapters", saved.id, "chapter.json"),
            ),
          ),
          memorySha256: null,
        },
      ],
    });
    const { fingerprintNativeImportFiles, nativeImportDigest } =
      await import("../src/main/libraryStore/importPublicationEvidence");
    expect(saved.pages.map((page) => page.name)).toEqual([
      second.name,
      first.name,
    ]);
    expect(mapping.items.map((item) => item.page.pageId)).toEqual(
      saved.pages.map((page) => page.id),
    );
    expect(mapping.items.map((item) => item.itemKey)).toEqual(review.itemKeys);
    expect(mapping.selectionFingerprint).toBe(review.selectionFingerprint);
    expect(mapping.sourceArchiveSha256).toBe(sha256(bytes));
    expect(mapping.chapterPageCounts).toEqual([2]);
    for (const [index, item] of mapping.items.entries()) {
      const page = saved.pages[index];
      expect(item.page).toMatchObject({
        revision: createPageRevision(page),
        reviewRevision: createSoundEffectReviewPageRevision(page),
        blockCount: 101,
        blockIdsSha256: sha256(
          JSON.stringify(page.blocks.map((block) => block.id)),
        ),
      });
      expect(page.blocks[0].id).toBe(`${page.id}-block-1`);
      expect(page.blocks[100].id).toBe(`${page.id}-block-101`);
      const original = await readFile(page.imagePath);
      expect(item.original).toEqual({
        bytes: original.length,
        sha256: sha256(original),
        format: "png",
      });
      expect(item.source).toEqual(item.original);
      expect(item.page.filesSha256).toBe(
        fingerprintNativeImportFiles([
          { role: "original", ...(await nativeImportDigest(page.imagePath)) },
          ...(page.inpaintedImagePath
            ? [
                {
                  role: "inpainted" as const,
                  ...(await nativeImportDigest(page.inpaintedImagePath)),
                },
              ]
            : []),
        ]),
      );
    }
    expect(JSON.stringify(mapping)).not.toContain(f.env.root);
    expect(JSON.stringify(mapping)).not.toContain(first.blocks[0].sourceText);
    await f.restart();
    expect(
      await f.invoke("carrot_get_work_file_import", {
        requestId: input.requestId,
      }),
    ).toEqual(receipt);
    expect(await f.createWorkFile(input)).toEqual(receipt);
    expect(await readFile(packagePath)).toEqual(bytes);
  } finally {
    await f.close();
  }
});

it("records reviewed append page IDs in the original destination transaction", async () => {
  const f = await workFileAppendFixture();
  try {
    const before = await f.capture();
    const { command } = await f.prepareAppend();
    const review = await f
      .current()
      .session.workFileReviewMapping("import-owner", command, () => {});
    const receipt = await f.createWorkFile(command);
    const mapping = receipt.pageMapping;
    if (!mapping)
      throw new Error("Appended workfile is missing its native page mapping");
    expect(receipt.workId).toBe("work");
    expect(mapping.selectionFingerprint).toBe(review.selectionFingerprint);
    expect(mapping.items.map((item) => item.itemKey)).toEqual(review.itemKeys);
    const saved = await f.library.openChapter(receipt.chapterIds[0]);
    expect(mapping.items.map((item) => item.page.pageId)).toEqual(
      saved.pages.map((page) => page.id),
    );
    expect(mapping.items.every((item) => item.page.workId === "work")).toBe(
      true,
    );
    expect(mapping.publication).toEqual({
      workId: "work",
      workSha256: sha256(await readFile(f.workPath)),
      guideSha256: sha256(before.guide),
      chapters: [
        {
          chapterId: saved.id,
          sha256: sha256(
            await readFile(
              join(
                f.env.libraryDir,
                "works",
                "work",
                "chapters",
                saved.id,
                "chapter.json",
              ),
            ),
          ),
          memorySha256: null,
        },
      ],
    });
    if (!mapping.publication)
      throw new Error("Native append did not retain publication metadata");
    const { verifyNativeImportPublicationMetadata } =
      await import("../src/main/libraryStore/importPublicationMetadata");
    await verifyNativeImportPublicationMetadata(mapping.publication, () => {});
    const changedGuide = JSON.parse(before.guide.toString("utf8"));
    changedGuide.rules.honorifics =
      changedGuide.rules.honorifics === "drop" ? "preserve" : "drop";
    await writeFile(f.guidePath, JSON.stringify(changedGuide));
    await expect(
      verifyNativeImportPublicationMetadata(mapping.publication, () => {}),
    ).rejects.toThrow("metadata changed");
    await writeFile(f.guidePath, before.guide);
    expect(await readFile(f.chapterPath)).toEqual(before.chapter);
    expect(await readFile(f.guidePath)).toEqual(before.guide);
  } finally {
    await f.close();
  }
});

it("retains exact native chapter metadata for selected empty chapters without fabricating page targets", async () => {
  const f = await workFileFixture();
  try {
    const source: LibraryChapter = JSON.parse(
      await readFile(f.chapterPath, "utf8"),
    );
    const empty: LibraryChapter = {
      ...source,
      id: "empty-source",
      title: "Empty selected chapter",
      status: "idle",
      pages: [],
      pageOrder: [],
    };
    delete empty.importSource;
    const workPath = join(f.env.libraryDir, "works", "work", "work.json");
    const work: LibraryWork = JSON.parse(await readFile(workPath, "utf8"));
    const emptyPath = join(
      dirname(workPath),
      "chapters",
      empty.id,
      "chapter.json",
    );
    await mkdir(dirname(emptyPath), { recursive: true });
    await writeFile(emptyPath, JSON.stringify(empty));
    await writeFile(
      workPath,
      JSON.stringify({
        ...work,
        chapterOrder: [...work.chapterOrder, empty.id],
      }),
    );
    const packagePath = join(f.env.root, "empty-chapter-mapping.mgtshare");
    await f.library.exportWorkShareToFile({
      workId: work.id,
      chapterIds: [source.id, empty.id],
      outputPath: packagePath,
    });
    const uploaded = await f.upload(await readFile(packagePath));
    const view = await f.review(uploaded.uploadId);
    const input = McpWorkFileCreateSchema.parse({
      requestId: randomUUID(),
      uploadId: uploaded.uploadId,
      snapshot: view.snapshot,
      target: { mode: "new", title: "Native empty chapter proof" },
      chapters: view.chapters.map(({ packageChapterId, title }) => ({
        packageChapterId,
        title,
      })),
      allowNativePreparation: true,
      acknowledgeV1Limitations: true,
    });
    const receipt = await f.createWorkFile(input);
    const mapping = receipt.pageMapping;
    if (!mapping?.publication)
      throw new Error(
        "Empty chapter import omitted native publication metadata",
      );
    expect(receipt.chapterIds).toHaveLength(2);
    expect(mapping.chapterPageCounts).toEqual([source.pages.length, 0]);
    expect(mapping.items.every((item) => item.chapterIndex === 0)).toBe(true);
    expect(
      mapping.publication.chapters.map((chapter) => chapter.chapterId),
    ).toEqual(receipt.chapterIds);
    const savedEmpty = await f.library.openChapter(receipt.chapterIds[1]);
    expect(savedEmpty.pages).toEqual([]);
    expect(mapping.publication.chapters[1]).toEqual({
      chapterId: savedEmpty.id,
      memorySha256: null,
      sha256: sha256(
        await readFile(
          join(
            f.env.libraryDir,
            "works",
            receipt.workId,
            "chapters",
            savedEmpty.id,
            "chapter.json",
          ),
        ),
      ),
    });
    const { verifyNativeImportPublicationMetadata } =
      await import("../src/main/libraryStore/importPublicationMetadata");
    await verifyNativeImportPublicationMetadata(mapping.publication, () => {});
    const savedEmptyPath = join(
      f.env.libraryDir,
      "works",
      receipt.workId,
      "chapters",
      savedEmpty.id,
      "chapter.json",
    );
    const emptyBytes = await readFile(savedEmptyPath);
    await writeFile(
      savedEmptyPath,
      JSON.stringify({
        ...JSON.parse(emptyBytes.toString("utf8")),
        title: "Changed empty imported chapter",
      }),
    );
    await expect(
      verifyNativeImportPublicationMetadata(mapping.publication, () => {}),
    ).rejects.toThrow("metadata changed");
    await writeFile(savedEmptyPath, emptyBytes);
  } finally {
    await f.close();
  }
});

it("rejects altered encrypted page or source bindings after restart without guessing replacement IDs", async () => {
  const f = await workFileFixture();
  try {
    const { command } = await f.prepareWorkFile();
    const receipt = await f.createWorkFile(command);
    const path = await f.storage.path(receipt.id);
    const bytes = await readFile(path);
    const record = (await f.storage.record(receipt.id)) as {
      receipt: typeof receipt;
    };
    const mapping = record.receipt.pageMapping;
    if (!mapping) throw new Error("Receipt has no native mapping");
    const before = await f.library.listLibrary();
    for (const replacement of [
      { ...mapping, sourceArchiveSha256: sha256("wrong archive") },
      {
        ...mapping,
        items: mapping.items.map((item, index) =>
          index ? item : { ...item, itemKey: sha256("wrong key") },
        ),
      },
      {
        ...mapping,
        items: mapping.items.map((item, index) =>
          index
            ? item
            : { ...item, page: { ...item.page, chapterId: "wrong-chapter" } },
        ),
      },
    ]) {
      await writeFile(
        path,
        JSON.stringify(
          await f.codec.seal({
            ...record,
            receipt: { ...receipt, pageMapping: replacement },
          }),
        ),
      );
      await expect(
        f.invoke("carrot_get_work_file_import", {
          requestId: command.requestId,
        }),
      ).rejects.toThrow();
    }
    await writeFile(path, bytes);
    await f.restart();
    expect(
      await f.invoke("carrot_get_work_file_import", {
        requestId: command.requestId,
      }),
    ).toEqual(receipt);
    expect(await f.library.listLibrary()).toEqual(before);
  } finally {
    await f.close();
  }
});
