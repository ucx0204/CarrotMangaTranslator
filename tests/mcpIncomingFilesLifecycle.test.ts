import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import {
  receiveIncomingFile,
  prepareIncomingFile,
} from "./mcpIncomingFiles.fixture";

it("prepares only the owning connection's ready upload and never changes kind implicitly", async () => {
  const f = await libraryImportFixture();
  try {
    const uploaded = await receiveIncomingFile(f.invoke, f.bytes);
    const input = {
      requestId: randomUUID(),
      source: "local",
      kind: "images",
      uploadId: uploaded.uploadId,
    };
    const other = f.auth("other");
    const rejected = await f.settle(
      await f.invoke("carrot_prepare_uploaded_import", input, other),
      other.principalId,
    );
    expect(rejected.status).toBe("failed");
    const wrong = await f.settle(
      await f.invoke("carrot_prepare_uploaded_import", {
        ...input,
        requestId: randomUUID(),
        kind: "archive",
      }),
    );
    expect(wrong.status).toBe("failed");
    const prepared = await prepareIncomingFile(f, uploaded.uploadId);
    expect((await f.inspect(prepared.ref)).pages).toHaveLength(1);
    expect(f.choose).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
it("a frozen preview survives upload expiry and disposal without renewing the original upload", async () => {
  const f = await libraryImportFixture();
  try {
    const uploaded = await receiveIncomingFile(f.invoke, f.bytes);
    f.clock(uploaded.expiresAt - 1);
    const prepared = await prepareIncomingFile(f, uploaded.uploadId);
    expect(prepared.ref.expiresAt).toBeGreaterThan(uploaded.expiresAt);
    f.clock(uploaded.expiresAt);
    await expect(
      f.invoke("carrot_get_file_upload", { uploadId: uploaded.uploadId }),
    ).rejects.toThrow();
    await f.invoke("carrot_discard_file_upload", {
      uploadId: uploaded.uploadId,
    });
    const saved = await f.create(await f.command(prepared.ref));
    expect(
      await readFile(
        (await f.library.openChapter(saved.chapterIds[0])).pages[0].imagePath,
      ),
    ).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});
it("failed receipt encryption rolls back uploaded-source publication and keeps the reviewed preview reusable", async () => {
  const f = await libraryImportFixture();
  try {
    const uploaded = await receiveIncomingFile(f.invoke, f.bytes),
      prepared = await prepareIncomingFile(f, uploaded.uploadId);
    const command = await f.command(prepared.ref),
      before = await f.library.listLibrary();
    const seal = f.codec.seal.bind(f.codec);
    let injected = false;
    vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      if (
        value &&
        typeof value === "object" &&
        "receipt" in value &&
        "fingerprint" in value
      ) {
        injected = true;
        throw new Error("Injected receipt failure");
      }
      return seal(value);
    });
    const done = await f.settle(
      await f.invoke("carrot_import_chapters", command),
    );
    vi.restoreAllMocks();
    expect(injected).toBe(true);
    expect(done.status).toBe("failed");
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect((await f.inspect(prepared.ref)).status).toBe("ready");
    const saved = await f.create({ ...command, requestId: randomUUID() });
    expect(saved.chapterIds).toHaveLength(1);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});
it("server stop at native image validation prevents uploaded input publication", async () => {
  const f = await libraryImportFixture();
  try {
    const uploaded = await receiveIncomingFile(f.invoke, f.bytes),
      prepared = await prepareIncomingFile(f, uploaded.uploadId);
    const input = await f.command(prepared.ref),
      before = await f.library.listLibrary();
    f.validate.mockImplementationOnce(async () => {
      f.current().session.stop();
    });
    const done = await f.settle(
      await f.invoke("carrot_import_chapters", input),
    );
    expect(done.status).not.toBe("completed");
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(await readFile(f.originals[0])).toEqual(f.bytes);
  } finally {
    await f.close();
  }
});
