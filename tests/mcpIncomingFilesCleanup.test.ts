import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { libraryImportFixture } from "./mcpLibraryImport.fixture";
import { importWebBoundary } from "./mcpLibraryImportWeb.fixture";
import { receiveIncomingFile } from "./mcpIncomingFiles.fixture";

it("cleans the owned incoming file even when closing an unrelated browser provider fails", async () => {
  const paths: string[] = [];
  const web = importWebBoundary(() => paths);
  const f = await libraryImportFixture({ web });
  try {
    paths.push(f.originals[0]);
    const upload = await receiveIncomingFile(f.invoke, f.bytes);
    const candidates = (await readdir(tmpdir(), { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith("carrot-mcp-input-"),
      )
      .map((entry) => join(tmpdir(), entry.name, `${upload.uploadId}.png`));
    const own = [];
    for (const path of candidates) {
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (info?.isFile()) own.push(path);
    }
    expect(own).toHaveLength(1);
    const scanned = await f.settle(
      await f.invoke("carrot_scan_import_url", {
        requestId: randomUUID(),
        source: "web",
        url: "https://example.com/chapter",
        allowNetwork: true,
      }),
    );
    expect(scanned.status).toBe("completed");
    web.dispose.mockRejectedValueOnce(
      new Error("Injected browser shutdown failure"),
    );
    await expect(f.current().session.close()).rejects.toThrow();
    await expect(lstat(own[0])).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await f.library.openChapter("chapter")).pages.length,
    ).toBeGreaterThan(0);
  } finally {
    web.dispose.mockResolvedValue(undefined);
    await f.close();
  }
});
