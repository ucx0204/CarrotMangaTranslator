import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { workFileFixture } from "./mcpWorkFileImport.fixture";

it("reviews the native working file without publication, decoding, picker or false backup promises", async () => {
  const f = await workFileFixture();
  try {
    const before = await f.library.listLibrary();
    const { uploaded, view } = await f.prepareWorkFile();
    expect(view).toMatchObject({
      pageCount: 2,
      chapterCount: 1,
      hasStyleGuide: true,
      targetMode: "new-work-only",
      retention: "requires-live-upload",
      expiresAt: uploaded.expiresAt,
    });
    expect(view.chapters[0]).toMatchObject({
      blockCount: 4,
      processedPageCount: 1,
    });
    expect(view.warnings).toContain(
      "v1_does_not_restore_chapter_memory_local_masks_or_runtime_history",
    );
    expect(await f.review(uploaded.uploadId)).toEqual(view);
    expect(await f.library.listLibrary()).toEqual(before);
    expect(f.validateShare).not.toHaveBeenCalled();
    expect(f.choose).not.toHaveBeenCalled();
    expect(JSON.stringify(view)).not.toMatch(
      /imagePath|sourcePath|authorized-input|dataUrl/,
    );
    expect(await readFile(f.packagePath)).toEqual(f.packageBytes);
  } finally {
    await f.close();
  }
});

it("imports editable blocks, explicit reading order, processed images and style guide using the actual native transaction", async () => {
  const f = await workFileFixture();
  try {
    const before = await f.library.listLibrary();
    const { command } = await f.prepareWorkFile();
    const receipt = await f.createWorkFile(command);
    const chapter = await f.library.openChapter(receipt.chapterIds[0]);
    expect(receipt.pageCount).toBe(2);
    expect(chapter.id).not.toBe("chapter");
    for (const [index, page] of chapter.pages.entries()) {
      const source = f.originalChapter.pages[index];
      expect(page.id).not.toBe(source.id);
      expect(await readFile(page.imagePath)).toEqual(
        await readFile(source.imagePath),
      );
      expect(page.blocks.map(({ id: _id, ...block }) => block)).toEqual(
        source.blocks.map(({ id: _id, ...block }: { id: string }) => block),
      );
    }
    expect(chapter.pages[0].blockOrder).toEqual(
      chapter.pages[0].blocks.map((block) => block.id).reverse(),
    );
    const processed = chapter.pages[0].inpaintedImagePath;
    if (!processed)
      throw new Error("Native share did not restore processed image");
    expect(await readFile(processed)).toEqual(await readFile(f.originals[1]));
    const style = JSON.parse(
      await readFile(
        join(f.env.libraryDir, "works", receipt.workId, "style-guide.json"),
        "utf8",
      ),
    );
    expect(style.workId).toBe(receipt.workId);
    expect((await f.library.listLibrary()).works.length).toBe(
      before.works.length + 1,
    );
    expect(await readFile(f.packagePath)).toEqual(f.packageBytes);
    expect(
      await readFile(await f.storage.path(receipt.id), "utf8"),
    ).not.toContain("Editable work");
  } finally {
    await f.close();
  }
});

it("reconstructs receipt and historical publication after the original upload is disposed", async () => {
  const f = await workFileFixture();
  try {
    const { command } = await f.prepareWorkFile();
    const receipt = await f.createWorkFile(command);
    await f.invoke("carrot_discard_file_upload", {
      uploadId: command.uploadId,
    });
    const before = await f.library.listLibrary();
    await f.restart();
    expect(
      await f.invoke("carrot_get_work_file_import", {
        requestId: command.requestId,
      }),
    ).toEqual(receipt);
    expect(await f.createWorkFile(command)).toEqual(receipt);
    vi.spyOn(f.persistence, "load").mockResolvedValueOnce(null);
    await f.restart();
    expect(f.current().operations.list("import-owner", 0, 25).total).toBe(0);
    expect(await f.createWorkFile(command)).toEqual(receipt);
    expect(await f.library.listLibrary()).toEqual(before);
    await expect(f.review(command.uploadId)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("rejects changed requests, foreign receipts and repeated upload consumption after receipt disposal", async () => {
  const f = await workFileFixture();
  try {
    const { command } = await f.prepareWorkFile();
    const receipt = await f.createWorkFile(command);
    const before = await f.library.listLibrary();
    await expect(
      f.invoke("carrot_import_work_file", {
        ...command,
        target: { mode: "new", title: "changed" },
      }),
    ).rejects.toThrow();
    await expect(
      f.invoke(
        "carrot_get_work_file_import",
        { requestId: command.requestId },
        f.auth("other"),
      ),
    ).rejects.toThrow();
    const repeated = { ...command, requestId: randomUUID() };
    expect(
      (await f.settle(await f.invoke("carrot_import_work_file", repeated)))
        .status,
    ).toBe("failed");
    const { McpRetentionCatalog } =
      await import("../src/main/mcp/mcpRetentionCatalog");
    await new McpRetentionCatalog(
      f.storage,
      new AbortController().signal,
      false,
    ).discard("import-owner", receipt.id, () => {});
    expect(
      (
        await f.settle(
          await f.invoke("carrot_import_work_file", {
            ...command,
            requestId: randomUUID(),
          }),
        )
      ).status,
    ).toBe("failed");
    expect(await f.library.listLibrary()).toEqual(before);
    expect(
      (await f.library.openChapter(receipt.chapterIds[0])).pages.length,
    ).toBe(2);
  } finally {
    await f.close();
  }
});
