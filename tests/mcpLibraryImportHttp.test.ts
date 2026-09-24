import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { libraryImportHttpFixture as httpFixture } from "./mcpLibraryImportHttp.fixture";

it("publishes a selected import through HTTP and restores its owned receipt without reading source again", async () => {
  const f = await httpFixture();
  try {
    expect(
      (await f.call("carrot_get_import_target", { workId: "work" }, f.read))
        .result.isError,
    ).toBe(false);
    const choose = { requestId: randomUUID(), source: "local", kind: "images" };
    expect(
      (await f.call("carrot_choose_import_files", choose, f.read)).error
        .message,
    ).toBe("Unknown tool");
    expect(
      (
        await f.call("carrot_choose_import_files", {
          ...choose,
          path: "C:/private",
        })
      ).error.code,
    ).toBe(-32602);
    const input = await f.prepare();
    expect(
      (await f.call("carrot_get_import_preview", input, f.other)).error.code,
    ).toBe(-32602);
    const preview = { previewId: input.previewId, snapshot: input.snapshot };
    expect(
      (await f.call("carrot_get_import_preview", preview, f.other)).result
        .structuredContent.error,
    ).toBe("not_found");
    const accepted = await f.call("carrot_import_chapters", input);
    const completed = await f.settle(accepted.result.structuredContent);
    expect(completed).toMatchObject({ status: "completed" });
    const receipt = completed.result?.importReceipt;
    if (!receipt) throw new Error("Missing import receipt");
    const chapter = await f.library.openChapter(receipt.chapterIds[0]);
    expect(chapter.pages).toHaveLength(1);
    expect(await readFile(chapter.pages[0].imagePath)).toEqual(
      await readFile(f.originals[1]),
    );
    await f.restart();
    const restored = await f.call("carrot_get_import_receipt", {
      requestId: input.requestId,
    });
    expect(restored.result?.isError, JSON.stringify(restored)).toBe(false);
    expect(restored.result.structuredContent).toMatchObject({
      ...receipt,
      availableChapterIds: receipt.chapterIds,
    });
    expect(
      (
        await f.call(
          "carrot_get_import_receipt",
          { requestId: input.requestId },
          f.other,
        )
      ).result.structuredContent.error,
    ).toBe("not_found");
    const repeated = await f.call("carrot_import_chapters", input);
    expect(repeated.result.structuredContent.jobId).toBe(
      accepted.result.structuredContent.jobId,
    );
    expect(f.choose).toHaveBeenCalledOnce();
    expect(f.validate).toHaveBeenCalledOnce();
    expect(JSON.stringify(restored)).not.toMatch(
      /sourcePath|authorized-input|dataUrl/,
    );
  } finally {
    await f.close();
  }
});

it("rolls back both chapters and receipt when an actual OAuth grant is revoked at encrypted publication", async () => {
  const f = await httpFixture();
  let revoked = false;
  let hook: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const input = await f.prepare();
    const before = await f.library.listLibrary();
    const owner = f.provider.connectionIdFor(`Bearer ${f.full}`);
    if (!owner) throw new Error("Missing fixture owner");
    const seal = f.codec.seal;
    hook = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const sealed = await seal(value);
      if (
        !revoked &&
        value &&
        typeof value === "object" &&
        "receipt" in value &&
        "fingerprint" in value
      ) {
        f.provider.revokeConnection(owner);
        revoked = true;
      }
      return sealed;
    });
    const response = await f.call("carrot_import_chapters", input);
    expect(response.result.isError).toBe(false);
    const done = await f
      .current()
      .operations.waitForCompletion(
        response.result.structuredContent.jobId,
        owner,
        new AbortController().signal,
      );
    expect(revoked).toBe(true);
    expect(done.status).not.toBe("completed");
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(await readFile(f.originals[0])).toEqual(f.bytes);
  } finally {
    hook?.mockRestore();
    await f.close();
  }
});
