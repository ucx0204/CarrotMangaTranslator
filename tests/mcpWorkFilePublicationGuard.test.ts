import {
  appendFileSync,
  createReadStream,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";
import type { McpArtifactRetention } from "../src/main/mcp/mcpArtifactTypes";

vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const publicationChanges = [
  {
    name: "growth beyond the reserved bytes during hashing",
    code: "invalid_edit",
    message: "Working file grew beyond its reserved output budget.",
    change: (path: string) => appendFileSync(path, Buffer.from([1])),
  },
  {
    name: "replacement with different bytes of the same length",
    code: "revision_conflict",
    message: "Working file changed before publication.",
    change: (path: string) => {
      writeFileSync(path, Buffer.alloc(32, 2));
      const changedAt = new Date(Date.now() + 60_000);
      utimesSync(path, changedAt, changedAt);
    },
  },
];

it.each(publicationChanges)(
  "rejects $name before retention and cleans only its unpublished file",
  async ({ change, code, message }) => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const retain = vi.fn<McpArtifactRetention>(async () => "unexpected");
    const store = new McpArtifactStore(
      "https://workfile.test",
      Date.now,
      retain,
    );
    let file = "",
      sibling = "";
    // Mutate the real file after its first stat, when the real read stream opens.
    // This controls the filesystem boundary without timing races or domain mocks.
    vi.mocked(createReadStream).mockImplementationOnce((path, options) => {
      change(file);
      return actual.createReadStream(path, options);
    });
    try {
      await expect(
        store.putWorkFile(
          async (path) => {
            file = path;
            sibling = join(dirname(path), "unrelated-output.bin");
            await writeFile(sibling, "preserve until session closure");
            await writeFile(path, Buffer.alloc(32, 1));
          },
          32,
          async () => {},
          new AbortController().signal,
          [
            {
              chapterId: "chapter",
              pageId: "page",
              revision: "page-v1:0000000000000000",
            },
          ],
          { workId: "work", chapterIds: ["chapter"], snapshot: "0".repeat(16) },
        ),
      ).rejects.toMatchObject({ code, message });
      expect(retain).not.toHaveBeenCalled();
      await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(sibling, "utf8")).toBe(
        "preserve until session closure",
      );
    } finally {
      vi.mocked(createReadStream)
        .mockReset()
        .mockImplementation(actual.createReadStream);
      await store.close();
    }
  },
);
