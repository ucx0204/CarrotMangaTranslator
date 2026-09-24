import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { workFileAppendFixture } from "./mcpWorkFileAppend.fixture";

it("rolls back the entire append on encryption failure and permits an explicit retry", async () => {
  const f = await workFileAppendFixture();
  try {
    const { command } = await f.prepareAppend();
    const before = await f.capture();
    const failure = vi
      .spyOn(f.codec, "seal")
      .mockRejectedValueOnce(new Error("Injected encryption failure"));
    expect(
      (await f.settle(await f.invoke("carrot_import_work_file", command)))
        .status,
    ).toBe("failed");
    failure.mockRestore();
    expect(await f.capture()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(
      (await f.createWorkFile({ ...command, requestId: randomUUID() })).workId,
    ).toBe("work");
  } finally {
    await f.close();
  }
});

it("rechecks append permission after staging encrypted metadata and preserves all previous files", async () => {
  const f = await workFileAppendFixture();
  try {
    const { command } = await f.prepareAppend();
    const before = await f.capture();
    const seal = f.codec.seal.bind(f.codec);
    let revoked = false;
    const spy = vi.spyOn(f.codec, "seal").mockImplementation(async (value) => {
      const sealed = await seal(value);
      if (value && typeof value === "object" && "entries" in value)
        revoked = true;
      return sealed;
    });
    const guard = () => {
      if (revoked) throw new Error("Append approval revoked");
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
    expect(await f.capture()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    await f.close();
  }
});

it("keeps an active append source leased and cancels without saving any new chapter", async () => {
  const f = await workFileAppendFixture();
  let release = () => {};
  try {
    const { command } = await f.prepareAppend();
    const before = await f.capture();
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
    expect(await f.capture()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
  } finally {
    release();
    await f.close();
  }
});

it("binds source lifetime and integrity through native append publication", async () => {
  const f = await workFileAppendFixture();
  try {
    const { command } = await f.prepareAppend();
    const before = await f.capture();
    f.boundary.beforeImage = async () => {
      f.boundary.beforeImage = undefined;
      if (!f.boundary.sourcePath) throw new Error("Missing owned test input");
      await writeFile(f.boundary.sourcePath, "changed package");
    };
    expect(
      (await f.settle(await f.invoke("carrot_import_work_file", command)))
        .status,
    ).toBe("failed");
    expect(await f.capture()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    const next = await f.prepareAppend();
    const upload = (await f.invoke("carrot_get_file_upload", {
      uploadId: next.command.uploadId,
    })) as { expiresAt: number };
    f.boundary.beforeImage = async () => {
      f.clock(upload.expiresAt);
    };
    expect(
      (await f.settle(await f.invoke("carrot_import_work_file", next.command)))
        .status,
    ).toBe("failed");
    expect(await f.capture()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("preserves absence of destination context and uses stable review snapshots without writing defaults", async () => {
  const f = await workFileAppendFixture();
  try {
    await unlink(f.guidePath);
    const before = await readFile(f.chapterPath);
    const { input, review, command } = await f.prepareAppend();
    expect(await f.inspectAppend(input)).toEqual(review);
    await f.createWorkFile(command);
    await expect(readFile(f.guidePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(f.chapterPath)).toEqual(before);
  } finally {
    await f.close();
  }
});
