import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { mcpLibraryImportOutputs } from "../src/shared/mcpLibraryImport";

it("rolls back both chapters and encrypted receipt when approval is revoked during receipt encryption", async () => {
  const f = await libraryImportFixture();
  try {
    const before = await f.library.listLibrary();
    const input = await f.command(await f.prepare());
    const { McpEditError } =
      await import("../src/main/application/mcpEditPolicy");
    let allowed = true;
    const guard = () => {
      if (!allowed)
        throw new McpEditError("access_denied", "Fixture approval revoked");
    };
    const original = f.codec.seal.bind(f.codec);
    const seal = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const encrypted = await original(value);
      if (value && typeof value === "object" && "receipt" in value)
        allowed = false;
      return encrypted;
    });
    const done = await f.settle(
      await f.invoke(
        "carrot_import_chapters",
        input,
        f.auth("import-owner", guard),
      ),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "access_denied" },
    });
    seal.mockRestore();
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(await readFile(f.originals[0])).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});

it("exposes the durable import after a post-commit crash and refuses a different request for the same preview", async () => {
  const f = await libraryImportFixture();
  let removeCrash = () => {};
  try {
    const input = await f.command(await f.prepare());
    const tx = await import("../src/main/libraryStore/libraryTransaction");
    removeCrash = tx.setLibraryTransactionCrashInjectorForTests((point) => {
      if (point === "after-commit-point")
        throw new tx.SimulatedLibraryTransactionCrash(point);
    });
    const first = await f.settle(
      await f.invoke("carrot_import_chapters", input),
    );
    expect(["failed", "completed"]).toContain(first.status);
    removeCrash();
    const receipt = mcpLibraryImportOutputs.carrot_get_import_receipt.parse(
      await f.invoke("carrot_get_import_receipt", {
        requestId: input.requestId,
      }),
    );
    expect(receipt.availableChapterIds).toHaveLength(1);
    const second = await f.settle(
      await f.invoke("carrot_import_chapters", {
        ...input,
        requestId: randomUUID(),
      }),
    );
    expect(second).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect((await f.library.listLibrary()).works).toHaveLength(2);
    await f.restart();
    expect(
      await f.invoke("carrot_get_import_receipt", {
        requestId: input.requestId,
      }),
    ).toEqual(receipt);
    expect(f.validate).toHaveBeenCalledTimes(2);
  } finally {
    removeCrash();
    await f.close();
  }
});

it("keeps existing work identity and page data while appending only selected new pages", async () => {
  const f = await libraryImportFixture();
  try {
    const original = await readFile(f.chapterPath);
    const ref = await f.prepare();
    const input = await f.command(ref);
    const target = mcpLibraryImportOutputs.carrot_get_import_target.parse(
      await f.invoke("carrot_get_import_target", { workId: "work" }),
    );
    input.target = {
      mode: "existing",
      workId: "work",
      snapshot: target.snapshot,
    };
    input.chapters[0].pageIds = input.chapters[0].pageIds.slice(1);
    const receipt = await f.create(input);
    expect(receipt).toMatchObject({ workId: "work", pageCount: 1 });
    expect((await f.library.listLibrary()).works).toHaveLength(1);
    expect(await readFile(f.chapterPath)).toEqual(original);
    expect(
      (await f.library.openChapter(receipt.chapterIds[0])).pages.map(
        (page) => page.name,
      ),
    ).toEqual(["second.png"]);
    await expect(
      f.invoke(
        "carrot_get_import_receipt",
        { requestId: input.requestId },
        f.auth("other"),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.invoke("carrot_import_chapters", {
        ...input,
        chapters: [{ ...input.chapters[0], title: "Different" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_edit" });
  } finally {
    await f.close();
  }
});

it("expires uncommitted previews without creating a new native job from retained preview metadata", async () => {
  const f = await libraryImportFixture();
  try {
    const ref = await f.prepare();
    const input = await f.command(ref);
    f.clock(ref.expiresAt);
    const done = await f.settle(
      await f.invoke("carrot_import_chapters", input),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "not_found" },
    });
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.choose).toHaveBeenCalledOnce();
    expect((await f.library.listLibrary()).works).toHaveLength(1);
  } finally {
    await f.close();
  }
});
