import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workFileFixture } from "./mcpWorkFileImport.fixture";

it("rejects unreviewed selection, missing acknowledgment, foreign inputs and image-archive substitution", async () => {
  const f = await workFileFixture();
  try {
    const { command } = await f.prepareWorkFile();
    const before = await f.library.listLibrary();
    for (const bad of [
      { ...command, acknowledgeV1Limitations: false },
      { ...command, allowNativePreparation: false },
      { ...command, target: { mode: "existing", workId: "work" } },
      { ...command, chapters: [...command.chapters, ...command.chapters] },
      { ...command, packagePath: f.packagePath },
    ])
      await expect(f.invoke("carrot_import_work_file", bad)).rejects.toThrow();
    for (const bad of [
      { ...command, snapshot: "0".repeat(16) },
      { ...command, chapters: [{ packageChapterId: "absent", title: "no" }] },
    ]) {
      expect(
        (
          await f.settle(
            await f.invoke("carrot_import_work_file", {
              ...bad,
              requestId: randomUUID(),
            }),
          )
        ).status,
      ).toBe("failed");
    }
    await expect(
      f.invoke(
        "carrot_preview_work_file",
        { uploadId: command.uploadId },
        f.auth("foreign"),
      ),
    ).rejects.toThrow();
    const image = await f.upload(f.bytes, "not-a-work.png");
    await expect(f.review(image.uploadId)).rejects.toThrow();
    const broken = await f.upload(Buffer.from("not a ZIP"));
    await expect(f.review(broken.uploadId)).rejects.toThrow();
    const flattened = await f.settle(
      await f.invoke("carrot_prepare_uploaded_import", {
        requestId: randomUUID(),
        uploadId: command.uploadId,
        source: "local",
        kind: "archive",
      }),
    );
    expect(flattened.status).toBe("failed");
    expect(f.validateShare).not.toHaveBeenCalled();
    expect(await f.library.listLibrary()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("rolls back the native work when authorization is revoked during image validation", async () => {
  const f = await workFileFixture();
  try {
    const { command } = await f.prepareWorkFile();
    const before = await f.library.listLibrary();
    let revoked = false;
    f.boundary.beforeImage = async () => {
      revoked = true;
    };
    const guard = () => {
      if (revoked) throw new Error("Revoked during native validation");
    };
    const done = await f.settle(
      await f.invoke(
        "carrot_import_work_file",
        command,
        f.auth("import-owner", guard),
      ),
    );
    expect(done.status).toBe("failed");
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    revoked = false;
    f.boundary.beforeImage = undefined;
    const receipt = await f.createWorkFile({
      ...command,
      requestId: randomUUID(),
    });
    expect(receipt.pageCount).toBe(2);
  } finally {
    await f.close();
  }
});

it("rolls back tampered or expired input rather than publishing a partly imported work", async () => {
  const f = await workFileFixture();
  try {
    const { command, uploaded } = await f.prepareWorkFile();
    const before = await f.library.listLibrary();
    f.boundary.beforeImage = async () => {
      f.boundary.beforeImage = undefined;
      if (!f.boundary.sourcePath) throw new Error("Missing native input path");
      await writeFile(f.boundary.sourcePath, Buffer.from("tampered"));
    };
    expect(
      (await f.settle(await f.invoke("carrot_import_work_file", command)))
        .status,
    ).toBe("failed");
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    if (!f.boundary.sourcePath) throw new Error("Missing owned test input");
    await writeFile(f.boundary.sourcePath, f.packageBytes);
    f.boundary.beforeImage = async () => {
      f.clock(uploaded.expiresAt);
    };
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
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});

it("receipt encryption failure rolls back the work and leaves the same reviewed input reusable", async () => {
  const f = await workFileFixture();
  try {
    const { command } = await f.prepareWorkFile();
    const before = await f.library.listLibrary();
    const seal = vi
      .spyOn(f.codec, "seal")
      .mockRejectedValueOnce(new Error("Injected encryption failure"));
    expect(
      (await f.settle(await f.invoke("carrot_import_work_file", command)))
        .status,
    ).toBe("failed");
    seal.mockRestore();
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(
      (await f.createWorkFile({ ...command, requestId: randomUUID() }))
        .pageCount,
    ).toBe(2);
  } finally {
    await f.close();
  }
});

it("holds the uploaded source against disposal, and cancellation leaves no partial work", async () => {
  const f = await workFileFixture();
  let release = () => {};
  try {
    const { command } = await f.prepareWorkFile();
    const before = await f.library.listLibrary();
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.boundary.beforeImage = async () => {
      entered();
      await paused;
    };
    const accepted = (await f.invoke("carrot_import_work_file", command)) as {
      jobId: string;
    };
    await waiting;
    await expect(
      f.invoke("carrot_discard_file_upload", { uploadId: command.uploadId }),
    ).rejects.toThrow();
    await f.current().operations.cancel(accepted.jobId, "import-owner");
    release();
    expect((await f.settle(accepted)).status).toBe("cancelled");
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    release();
    await f.close();
  }
});
