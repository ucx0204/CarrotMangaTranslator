import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workFileFixture } from "./mcpWorkFileImport.fixture";

it("rejects altered encrypted work-file receipts instead of trusting their catalog identity", async () => {
  const f = await workFileFixture();
  try {
    const { command } = await f.prepareWorkFile();
    const receipt = await f.createWorkFile(command);
    const path = await f.storage.path(receipt.id);
    const bytes = await readFile(path);
    const record = (await f.storage.record(receipt.id)) as {
      receipt: { pageCount: number; packageChapterIds: string[] };
      input: { target: { title: string } };
    };
    const altered = [
      { ...record, receipt: { ...record.receipt, pageCount: 3 } },
      {
        ...record,
        receipt: { ...record.receipt, packageChapterIds: ["other"] },
      },
      {
        ...record,
        input: { ...record.input, target: { mode: "new", title: "changed" } },
      },
    ];
    const before = await f.library.listLibrary();
    for (const value of altered) {
      await writeFile(path, JSON.stringify(await f.codec.seal(value)));
      await expect(
        f.invoke("carrot_get_work_file_import", {
          requestId: command.requestId,
        }),
      ).rejects.toThrow();
      expect(await f.library.listLibrary()).toEqual(before);
    }
    await writeFile(path, bytes);
    expect(
      await f.invoke("carrot_get_work_file_import", {
        requestId: command.requestId,
      }),
    ).toEqual(receipt);
  } finally {
    await f.close();
  }
});

it("expires a work-file receipt without deleting the imported work or reviving its live upload", async () => {
  const f = await workFileFixture();
  try {
    const { command } = await f.prepareWorkFile();
    const receipt = await f.createWorkFile(command);
    const chapter = await f.library.openChapter(receipt.chapterIds[0]);
    f.clock(receipt.expiresAt);
    await expect(
      f.invoke("carrot_get_work_file_import", { requestId: command.requestId }),
    ).rejects.toThrow();
    await expect(f.review(command.uploadId)).rejects.toThrow();
    expect(await f.library.openChapter(receipt.chapterIds[0])).toEqual(chapter);
    expect(await readFile(f.packagePath)).toEqual(f.packageBytes);
  } finally {
    await f.close();
  }
});

it("rolls back work and receipt if permission is revoked while the encrypted index is staged", async () => {
  const f = await workFileFixture();
  try {
    const { command } = await f.prepareWorkFile();
    const before = await f.library.listLibrary();
    const seal = f.codec.seal;
    let revoked = false;
    const spy = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const sealed = await seal(value);
      if (typeof value === "object" && value !== null && "entries" in value) {
        revoked = true;
      }
      return sealed;
    });
    const guard = () => {
      if (revoked) throw new Error("Revoked during encrypted index staging");
    };
    const done = await f.settle(
      await f.invoke(
        "carrot_import_work_file",
        command,
        f.auth("import-owner", guard),
      ),
    );
    spy.mockRestore();
    expect(revoked).toBe(true);
    expect(done.status).toBe("failed");
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(await f.review(command.uploadId)).toMatchObject({
      snapshot: command.snapshot,
    });
  } finally {
    await f.close();
  }
});

it("rejects ambiguous owned request history without selecting or changing either retained identity", async () => {
  const f = await workFileFixture();
  try {
    const { command } = await f.prepareWorkFile();
    const receipt = await f.createWorkFile(command);
    const before = await f.library.listLibrary();
    const validations = f.validateShare.mock.calls.length;
    const recordPath = await f.storage.path(receipt.id);
    const recordBytes = await readFile(recordPath);
    const indexPath = await f.storage.path();
    const indexBytes = await readFile(indexPath);
    const index = await f.storage.index();
    const entry = index.entries.find((item) => item.id === receipt.id);
    if (!entry) throw new Error("Native work-file receipt was not indexed");
    await writeFile(
      indexPath,
      JSON.stringify(
        await f.codec.seal({
          ...index,
          entries: [...index.entries, { ...entry, id: randomUUID() }],
        }),
      ),
    );
    try {
      await expect(
        f.invoke("carrot_get_work_file_import", {
          requestId: command.requestId,
        }),
      ).rejects.toThrow("Duplicate working-file receipt identity.");
      expect(await f.library.listLibrary()).toEqual(before);
      expect(await readFile(recordPath)).toEqual(recordBytes);
      expect(f.validateShare).toHaveBeenCalledTimes(validations);
    } finally {
      await writeFile(indexPath, indexBytes);
    }
    expect(
      await f.invoke("carrot_get_work_file_import", {
        requestId: command.requestId,
      }),
    ).toEqual(receipt);
    expect(await readFile(f.packagePath)).toEqual(f.packageBytes);
  } finally {
    await f.close();
  }
});
