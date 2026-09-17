import { lstat, rm, writeFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

it.each(["ENOENT", "EIO"])(
  "refuses an output when file inspection fails with %s",
  async (code) => {
    const store = new McpArtifactStore("https://files.test");
    try {
      const file = await store.put(Buffer.from("PNG"), async () => {});
      const error = Object.assign(new Error("fixture inspection failure"), {
        code,
      });
      vi.mocked(lstat).mockRejectedValueOnce(error);
      if (code === "ENOENT")
        await expect(store.assertAvailable(file.url)).rejects.toMatchObject({
          code: "not_found",
        });
      else await expect(store.assertAvailable(file.url)).rejects.toBe(error);
      await expect(store.assertAvailable(file.url)).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  },
);

it("rejects symlink metadata, wrong suffixes, duplicate names and empty ZIPs", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  const store = new McpArtifactStore("https://files.test");
  try {
    const file = await store.put(Buffer.from("PNG"), async () => {});
    vi.mocked(lstat).mockImplementationOnce(async (...args) => {
      const stats = await actual.lstat(...args);
      stats.isSymbolicLink = () => true;
      return stats;
    });
    await expect(store.assertAvailable(file.url)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      store.assertAvailable(file.url.replace("page.png", "pages.zip")),
    ).rejects.toMatchObject({ code: "not_found" });
    const signal = new AbortController().signal;
    const check = async () => {};
    await expect(store.zip([], {}, check, signal)).rejects.toMatchObject({
      code: "invalid_edit",
    });
    await expect(
      store.zip(
        [
          { url: file.url, filename: "0001.png" },
          { url: file.url, filename: "0001.png" },
        ],
        {},
        check,
        signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_edit" });
    await expect(
      store.zip([{ url: file.url, filename: "../image.png" }], {}, check, signal),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await store.close();
  }
});

it("reports both write and cleanup failures and permits the next explicit write", async () => {
  const store = new McpArtifactStore("https://files.test");
  try {
    const writeError = new Error("fixture write failure");
    const cleanupError = new Error("fixture cleanup failure");
    vi.mocked(writeFile).mockRejectedValueOnce(writeError);
    vi.mocked(rm).mockRejectedValueOnce(cleanupError);
    await expect(
      store.put(Buffer.from("PNG"), async () => {}),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [writeError, cleanupError],
      cause: cleanupError,
    });
    const file = await store.put(Buffer.from("retry"), async () => {});
    await expect(store.assertAvailable(file.url)).resolves.toBeUndefined();
  } finally {
    await store.close();
  }
});
