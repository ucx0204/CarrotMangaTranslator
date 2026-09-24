import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { importWebBoundary } from "./mcpLibraryImportWeb.fixture";
import { receiveIncomingFile } from "./mcpIncomingFiles.fixture";

it("retires captured input when web-session cleanup fails before exposing a preview", async () => {
  let paths: string[] = [];
  const web = importWebBoundary(() => paths);
  web.discardSession.mockRejectedValue(
    new Error("Synthetic session cleanup failure"),
  );
  const f = await libraryImportFixture({ web });
  paths = [f.originals[0]];
  const original = await readFile(paths[0]);
  try {
    const done = await f.settle(
      await f.invoke("carrot_scan_import_url", {
        source: "web",
        url: "https://example.com/chapter",
        allowNetwork: true,
        requestId: randomUUID(),
      }),
    );
    expect(done).toMatchObject({
      status: "failed",
      error: { code: "invalid_edit" },
    });
    expect(done.result?.importPreview).toBeUndefined();
    expect(web.prepareImport).toHaveBeenCalledOnce();
    expect(web.discardSession).toHaveBeenCalledOnce();
    expect(web.releasePrepared).toHaveBeenCalledOnce();
    expect(
      (await readdir(join(f.env.root, "tmp"))).filter((name) =>
        name.startsWith("mcp-import-"),
      ),
    ).toEqual([]);
    expect(await readFile(paths[0])).toEqual(original);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.validate).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
  expect(web.dispose).toHaveBeenCalledOnce();
});

it("preserves a browser cleanup failure while still removing owned uploads and leaving originals intact", async () => {
  let paths: string[] = [];
  const web = importWebBoundary(() => paths);
  const f = await libraryImportFixture({ web });
  paths = [f.originals[0]];
  try {
    const before = await f.library.listLibrary();
    const original = await readFile(paths[0]);
    const upload = await receiveIncomingFile(f.invoke, original, "owned.png");
    const uploadPath = await f.current().session.uploads.withFile(
      "import-owner",
      upload.uploadId,
      () => {},
      async (asset) => asset.path,
    );
    expect(await readFile(uploadPath)).toEqual(original);
    const prepared = await f.settle(
      await f.invoke("carrot_scan_import_url", {
        source: "web",
        url: "https://example.com/chapter",
        allowNetwork: true,
        requestId: randomUUID(),
      }),
    );
    expect(prepared.status).toBe("completed");
    const failure = new Error("External browser disposal failed");
    web.dispose.mockRejectedValueOnce(failure);
    let caught: unknown;
    try {
      await f.current().session.close();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError))
      throw new Error("Import close did not retain its cleanup failure");
    expect(caught.cause).toBe(failure);
    expect(caught.errors).toEqual([failure]);
    expect(web.dispose).toHaveBeenCalledOnce();
    await expect(readFile(uploadPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(paths[0])).toEqual(original);
    expect(await f.library.listLibrary()).toEqual(before);
    expect((await f.storage.index()).entries).toEqual([]);
    expect(f.validate).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
