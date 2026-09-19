import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { McpArtifactStore } from "../src/main/mcp/mcpArtifactStore";
import { mcpZipBudget } from "../src/main/mcp/mcpArtifactZip";

vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
const token = (url: string) => new URL(url).pathname.split("/")[2];
const binding = {
  chapterId: "chapter",
  pageId: "page",
  revision: "page-v1:0000000000000000",
};

it("removes unpublished PNG bytes and releases the reserved budget when durable retention fails", async () => {
  const failure = new Error("durable publication failed");
  let rejectedPath = "";
  const retain = vi.fn(async (entry: { file: string }) => {
    rejectedPath = entry.file;
    throw failure;
  });
  const store = new McpArtifactStore(
    "https://retention.test",
    Date.now,
    retain,
  );
  try {
    await expect(
      store.put(Buffer.from("not retained"), async () => {}, binding),
    ).rejects.toBe(failure);
    await expect(readFile(rejectedPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(retain).toHaveBeenCalledTimes(1);
    const next = await store.put(
      Buffer.from("unbound local output"),
      async () => {},
    );
    expect(await store.read(token(next.url))).toEqual(
      Buffer.from("unbound local output"),
    );
  } finally {
    await store.close();
  }
});

it("preserves publication and cleanup failures without publishing a link", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const failure = new Error("retention unavailable"),
    cleanup = new Error("cleanup denied");
  let path = "";
  const store = new McpArtifactStore(
    "https://retention.test",
    Date.now,
    async (entry) => {
      path = entry.file;
      vi.mocked(rm).mockRejectedValueOnce(cleanup);
      throw failure;
    },
  );
  try {
    await expect(
      store.put(Buffer.from("unpublished"), async () => {}, binding),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [failure, cleanup],
    });
    expect(await readFile(path)).toEqual(Buffer.from("unpublished"));
  } finally {
    vi.mocked(rm).mockImplementation(actual.rm);
    await store.close();
  }
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not delete borrowed files on admission failure, expiry or session shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-borrowed-test-"));
  const path = join(root, "retained.png"),
    bytes = Buffer.from("borrowed retained bytes");
  await writeFile(path, bytes);
  let now = 0,
    allowed = true;
  const store = new McpArtifactStore("https://retention.test", () => now);
  const metadata = {
    mimeType: "image/png" as const,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const guard = async () => {
    if (!allowed) throw new Error("permission revoked");
  };
  try {
    await expect(
      store.issueRetained(path, metadata, guard, async () => {
        allowed = false;
      }),
    ).rejects.toThrow("revoked");
    allowed = true;
    const link = await store.issueRetained(
      path,
      metadata,
      guard,
      async () => {},
    );
    expect(await store.read(token(link.url))).toEqual(bytes);
    now = link.expiresAt;
    await store.put(
      Buffer.from("trigger expired entry cleanup"),
      async () => {},
    );
    expect(await readFile(path)).toEqual(bytes);
    await expect(store.read(token(link.url))).rejects.toMatchObject({
      code: "not_found",
    });
    await store.close();
    expect(await readFile(path)).toEqual(bytes);
    await expect(
      store.issueRetained(path, metadata, guard, async () => {}),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects an oversized ZIP reservation before allocating or reducing source resolution", () => {
  expect(mcpZipBudget([{ size: 1024 }], { pages: 1 })).toBe(
    1024 + Buffer.byteLength(JSON.stringify({ pages: 1 })) + 1024 * 1024,
  );
  expect(() => mcpZipBudget([{ size: 128 * 1024 * 1024 }], {})).toThrow(
    "128 MiB",
  );
});
