import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

it.each(["ENOENT", "EACCES", "EIO"])(
  "validates an output read failure (%s) without re-rendering",
  async (code) => {
    const store = new McpArtifactStore("https://carrot.test");
    try {
      const artifact = await store.put(
        Buffer.from("test-only-png"),
        async () => {},
      );
      const failure = Object.assign(new Error("synthetic read error"), {
        code,
      });
      vi.mocked(readFile).mockRejectedValueOnce(failure);
      const pending = store.assertAvailable(artifact.url);
      if (code === "ENOENT")
        await expect(pending).rejects.toMatchObject({ code: "not_found" });
      else await expect(pending).rejects.toBe(failure);
      await expect(
        store.assertAvailable(artifact.url),
      ).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  },
);

it("accepts only an exact owned output URL and rejects changed file size", async () => {
  const store = new McpArtifactStore("https://carrot.test");
  try {
    const artifact = await store.put(
      Buffer.from("test-only-png"),
      async () => {},
    );
    for (const url of [
      artifact.url.replace("carrot.test", "foreign.test"),
      artifact.url + "?extra=1",
      artifact.url + "#extra",
      "https://carrot.test/mcp-artifacts/../../private",
      artifact.url.replace("page.png", "another.png"),
    ])
      await expect(store.assertAvailable(url)).rejects.toMatchObject({
        code: "not_found",
      });
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from("short"));
    await expect(store.assertAvailable(artifact.url)).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    await store.close();
  }
});
